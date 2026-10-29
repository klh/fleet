// src/litellm-ops.ts — W914 front-door parity: the LiteLLM-ops pass-through.
// Opaque/binary/model-less operations (files, batches, audio multipart,
// images/edits) ride a byte-faithful pipe to the configured ops group: no
// body parse, no aid injection (the registry's no-injection reason rides
// the audit row), scoped auth + budgets at the gate (proxy class), bounded
// admission slot, W3C child-span traceparent on the upstream leg, verbatim
// response (streaming/binary fidelity, upstream error semantics preserved:
// a 4xx/5xx body rides through untouched). JSON model-bearing ops
// (completions/embeddings/rerank/moderations/images/generations/audio/speech)
// dispatch through the normal proxy() ladder instead (wire-routes.ts).

import type { RpcAdmission } from "./admission.ts";
import type { CandidateRow, CandidateTable } from "./candidates.ts";
import { problem } from "./citizenship.ts";
import { latencyClass } from "./decide.ts";
import { matchEndpoint } from "./endpoints.ts";
import type { Ledger } from "./ledger.ts";
import { keyIdFromToken, tokenFromHeaders } from "./ledger.ts";
import { newRid } from "./request-context.ts";
import type { Servicemon } from "./servicemon.ts";
import { childSpanOf, newTraceparent, parseTraceparent } from "./trace.ts";

/** Structural deps slice — no proxy-ingress import (cycle-free). */
export interface OpsDeps {
	ledger: Ledger;
	sm: Servicemon;
	table: CandidateTable;
	admission?: RpcAdmission;
	hubId?: string;
	/** W914: the resolved gateway policy — the ops group knob
	 *  (routing-policy.json `gateway.litellm_ops.group`) rides it. */
	policy?: { litellm_ops?: { group?: string } };
}

export const OPS_GROUP_DEFAULT = "litellm-ops";

/** Ops upstream group: policy knob over the registry default
 *  (routing-policy.json `gateway.litellm_ops.group`; machine conf, never
 *  code). */
export function opsGroupOf(policy?: {
	litellm_ops?: { group?: string };
}): string {
	return policy?.litellm_ops?.group ?? OPS_GROUP_DEFAULT;
}

/** First healthy openai-dialect row of the ops group from the candidate
 *  table snapshot (cooldown-benched rows are unhealthy by construction). */
function resolveOpsRow(deps: OpsDeps, group: string): CandidateRow | null {
	const rows = deps.table
		.snapshot()
		.filter((r) => r.group === group && r.healthy && r.dialect === "openai");
	return rows[0] ?? null;
}

async function opsFetch(
	row: CandidateRow,
	req: Request,
	path: string,
	traceparent: string,
): Promise<Response> {
	const key =
		row.dep.api_key_env === undefined
			? undefined
			: process.env[row.dep.api_key_env];
	const headers: Record<string, string> = {
		traceparent: childSpanOf(traceparent),
	};
	const ct = req.headers.get("content-type");
	if (ct !== null) headers["content-type"] = ct;
	if (key !== undefined) headers.authorization = `Bearer ${key}`;
	const body = req.body === null ? null : await req.arrayBuffer();
	const url = new URL(path, row.dep.url).toString();
	return fetch(url, {
		method: req.method,
		headers,
		body,
		signal: req.signal,
	});
}

/** Response headers that ride back to the client: content-type always;
 *  content-length only when fetch did not auto-decompress (an upstream
 *  content-encoding would lie about the body bytes we hand back). */
function opsHeaders(resp: Response): Headers {
	const h = new Headers();
	const ct = resp.headers.get("content-type");
	if (ct !== null) h.set("content-type", ct);
	if (resp.headers.get("content-encoding") === null) {
		const cl = resp.headers.get("content-length");
		if (cl !== null) h.set("content-length", cl);
	}
	return h;
}

interface OpsAudit {
	rid: string;
	lane: string;
	actor: string;
	traceparent: string;
	row: CandidateRow | null;
	decision: string;
	why: string;
}

function opsAuditDecision(deps: OpsDeps, o: OpsAudit): void {
	deps.ledger.auditDecision({
		rid: o.rid,
		trace_id: o.traceparent.split("-")[1],
		ts: new Date().toISOString(),
		actor: o.actor,
		lane: o.lane,
		dialect: "openai",
		hint: "",
		candidates_seen: o.row === null ? 0 : 1,
		candidates_top: o.row?.candidate_id ?? "",
		target_kind: o.row?.kind ?? null,
		target_host: o.row?.host ?? null,
		target_port: o.row?.port ?? null,
		target_model: o.row?.model ?? null,
		decision: o.decision,
		latency_class: latencyClass(o.row?.estimate_ms ?? null),
		tier: "",
		allow_cloud: false,
		error_code: null,
		traffic_kind: "inference",
		repo_hash: null,
		account_tier: null,
		key_name: null,
		why: o.why,
		hop: "origin",
	});
}

/** Refusal path: audit row (denied audits too) + outcome + problem body. */
function opsDeny(
	deps: OpsDeps,
	o: OpsAudit,
	status: number,
	code: string,
	next?: string[],
): Response {
	opsAuditDecision(deps, { ...o, decision: "denied" });
	deps.ledger.auditOutcome(o.rid, {
		status,
		duration_ms: 0,
		ok: false,
		err: o.why,
	});
	return problem({ status, code, why: o.why, next });
}

/** Post-fetch bookkeeping: honest-unknown usage + request ledger row. */
function opsBookkeeping(
	deps: OpsDeps,
	actor: string,
	group: string,
	row: CandidateRow,
	rid: string,
): void {
	deps.ledger.auditUsage(rid, null, false, false);
	deps.ledger.record({
		key: actor,
		group,
		model: row.model,
		in_tok: 0,
		out_tok: 0,
		cache_r: 0,
		cache_c: 0,
		requests: 1,
	});
	deps.sm
		.counter(
			"buckle_usage_unknown_total",
			"Proxied responses where usage could not be observed.",
		)
		.inc();
}

/** Slot release rides the body drain (the RPC lives as long as the
 *  stream); non-body responses release inline. */
function releaseStream(release: (() => void) | null, resp: Response): void {
	if (release === null) return;
	if (resp.body === null) {
		release();
		return;
	}
	void resp.body
		.pipeTo(new WritableStream({ close: () => release?.() }))
		.catch(() => release?.());
}

function errmsg(e: unknown): string {
	return e instanceof Error ? e.message : "ops passthrough failed";
}

/** Error path: errored audit row + outcome + problem body. */
function opsError(
	deps: OpsDeps,
	o: OpsAudit,
	release: (() => void) | null,
	t0: number,
	e: unknown,
): Response {
	if (release !== null) release();
	const why = errmsg(e);
	opsAuditDecision(deps, { ...o, why });
	deps.ledger.auditOutcome(o.rid, {
		status: 502,
		duration_ms: Date.now() - t0,
		ok: false,
		err: why,
	});
	return problem({ status: 502, code: "buckle.upstream_error", why });
}

/** Bounded admission slot (W450): one slot per in-flight ops RPC; past the
 *  cap the gateway 429s + Retry-After — the house overload contract. */
function opsAdmit(
	deps: OpsDeps,
	group: string,
): { release: (() => void) | null; denied: Response | null } {
	if (deps.admission === undefined) return { release: null, denied: null };
	const release = deps.admission.tryAcquire(group);
	if (release !== null) return { release, denied: null };
	deps.sm
		.counter(
			"buckle_admission_refusals_total",
			"Proxy requests refused at the in-flight bound.",
		)
		.inc({ group });
	const resp = problem({
		status: 429,
		code: "buckle.overloaded",
		why: `gateway at max in-flight for ${group} (${String(deps.admission.capOf(group))})`,
	});
	resp.headers.set("retry-after", String(deps.admission.retryAfterS));
	return { release: null, denied: resp };
}

/** W914 ops dispatch: registered passthrough entries ride the byte-faithful
 *  pipe; unregistered paths return null (the wire 404s per registry). */
export async function opsRoutes(
	deps: OpsDeps,
	req: Request,
	path: string,
	lane = "",
): Promise<Response | null> {
	const entry = matchEndpoint(req.method, path);
	if (entry === null || entry.dispatch !== "passthrough") return null;
	const group = opsGroupOf(deps.policy);
	const row = resolveOpsRow(deps, group);
	const rid = newRid();
	const actor = keyIdFromToken(tokenFromHeaders(req.headers));
	const traceparent =
		parseTraceparent(req.headers.get("traceparent")) ?? newTraceparent();
	const why = `litellm ops passthrough (injection: none — ${entry.why ?? "opaque path"})`;
	if (row === null) {
		return opsDeny(
			deps,
			{
				rid,
				lane,
				actor,
				traceparent,
				row: null,
				decision: "denied",
				why: `litellm ops group '${group}' absent or unhealthy in the upstream pool`,
			},
			503,
			"buckle.ops_unconfigured",
		);
	}
	return opsProxy(
		deps,
		req,
		path,
		lane,
		group,
		row,
		rid,
		actor,
		traceparent,
		why,
	);
}

interface OpsSettle {
	deps: OpsDeps;
	row: CandidateRow;
	rid: string;
	lane: string;
	actor: string;
	traceparent: string;
	why: string;
	group: string;
	release: (() => void) | null;
	t0: number;
}

/** Settlement: delivered audit + outcome + honest-unknown usage + the
 *  stamped response headers. */
function opsSettle(s: OpsSettle, resp: Response): Response {
	s.deps.ledger.auditOutcome(s.rid, {
		status: resp.status,
		duration_ms: Date.now() - s.t0,
		ok: resp.ok,
		err: resp.ok ? null : `upstream ${String(resp.status)}`,
	});
	opsBookkeeping(s.deps, s.actor, s.group, s.row, s.rid);
	releaseStream(s.release, resp);
	const hs = opsHeaders(resp);
	hs.set("x-belt-rid", s.rid);
	hs.set(
		"x-belt-route",
		JSON.stringify({
			rid: s.rid,
			decision: "delivered",
			target: {
				kind: s.row.kind,
				host: s.row.host,
				port: s.row.port,
				model: s.row.model,
			},
			...(s.lane === "" ? {} : { lane: s.lane }),
		}),
	);
	return new Response(resp.body, { status: resp.status, headers: hs });
}

/** The passthrough leg: admission slot → byte-faithful fetch → settle. */
function opsProxy(
	deps: OpsDeps,
	req: Request,
	path: string,
	lane: string,
	group: string,
	row: CandidateRow,
	rid: string,
	actor: string,
	traceparent: string,
	why: string,
): Promise<Response> {
	const { release, denied } = opsAdmit(deps, group);
	if (denied !== null) return Promise.resolve(denied);
	const s: OpsSettle = {
		deps,
		row,
		rid,
		lane,
		actor,
		traceparent,
		why,
		group,
		release,
		t0: Date.now(),
	};
	return opsRun(s, req, path);
}

function opsFail(s: OpsSettle, e: unknown): Response {
	return opsError(
		s.deps,
		{
			rid: s.rid,
			lane: s.lane,
			actor: s.actor,
			traceparent: s.traceparent,
			row: s.row,
			decision: "errored",
			why: errmsg(e),
		},
		s.release,
		s.t0,
		e,
	);
}

/** Fetch + settle: the delivered row carries the no-injection reason; a
 *  transport failure rides opsFail. */
function opsRun(s: OpsSettle, req: Request, path: string): Promise<Response> {
	return opsFetch(s.row, req, path, s.traceparent).then(
		(resp) => {
			opsAuditDecision(s.deps, {
				rid: s.rid,
				lane: s.lane,
				actor: s.actor,
				traceparent: s.traceparent,
				row: s.row,
				decision: "delivered",
				why: s.why,
			});
			return opsSettle(s, resp);
		},
		(e: unknown) => opsFail(s, e),
	);
}
