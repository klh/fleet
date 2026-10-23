import type { TransportEvidence } from "../../telemetry/src/transport-evidence.ts";
// src/handlers.ts — wire handlers: the two ingress dialects (POST
// /v1/chat/completions openai-shape, POST /v1/messages anthropic-shape) plus
// /v1/messages/count_tokens and GET /v1/models. SSE responses pass through
// byte-identical (tee, never re-serialized); usage is sniffed from the
// terminal events per the W129 contract (streaming_handler.py semantics,
// MIT port). Errors follow the ingress dialect's error shape; unknown-usage
// streams record requests without token columns — honest omission, never
// estimated.

import { stampHopHeaders } from "../../telemetry/src/http-trace.ts";
import {
	PREFER_HEADER,
	parsePreferHeader,
} from "../../telemetry/src/prefer-header.ts";
import { resolveAdapter } from "./adapters/index.ts";
import type { RpcAdmission } from "./admission.ts";
import {
	affinityOn,
	affKeyOf,
	applyAffinity,
	type PrefixAffinity,
} from "./affinity.ts";
import type { AidsLedger } from "./aids.ts";
import { aidsRoutes, applyWireAids, gateCacheAlign } from "./aids-routes.ts";
import type { LaneTelemetryLog } from "./cache-boundary.ts";
import { type PrefixLedger, prefixFingerprintOf } from "./cache-fingerprint.ts";
import type { CandidateRow, CandidateTable } from "./candidates.ts";
import {
	allowOf,
	lanePrefixOf,
	methodNotAllowed,
	options204,
	PROBLEM_SLUGS,
	problem,
} from "./citizenship.ts";
import { scoreComplexity, textFromMessages } from "./complexity.ts";
import {
	type DecideResult,
	type DecisionKind,
	latencyClass,
	type RouteSelection,
} from "./decide.ts";
import { type DietStore, dietRoutes } from "./diet.ts";
import type { Expander } from "./expand.ts";
import { type Federation, principalOf } from "./gov/federation.ts";
import { hintFromHeaders, type RouteHint } from "./hints.ts";
import {
	type HopContext,
	hopBaggageOf,
	hopFromBaggage,
	hopKindOf,
	laneFromBaggage,
} from "./hop.ts";
import {
	INGRESS_BODY_TIMEOUT_MS,
	IngressBodyError,
	MAX_REQUEST_BODY_BYTES,
	readIngressJson,
} from "./ingress-body.ts";
import { keyIdFromToken, type Ledger, tokenFromHeaders } from "./ledger.ts";
import type { ObservationOutbox } from "./observe.ts";
import { type CondenseStore, pipelineRoutes } from "./pipeline.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Preseeder } from "./preseed.ts";
import type { RepoPolicyRow } from "./repo-policy.ts";
import { repoPolicyRoutes } from "./repo-policy-routes.ts";
import { type ExecuteResult, type Router, UpstreamError } from "./router.ts";
import type { Servicemon } from "./servicemon.ts";
import {
	allowlistedBaggage,
	newTraceparent,
	parseTraceparent,
	type TraceContext,
} from "./trace.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";
import {
	SSE_HEADERS,
	jsonResponse,
	observe,
	scrubText,
} from "./handlers-settle.ts";
import { streamResponse } from "./stream-handler.ts";

export interface AppDeps {
	router: Router;
	ledger: Ledger;
	sm: Servicemon;
	pool: UpstreamPool;
	// W140: the pure decision over the candidate table + the table itself
	// (EWMA outcomes, in-flight load)
	decide: (input: {
		group: string;
		dialect: Dialect;
		hint: RouteHint | null;
		hintRaw: string;
		allowCross: boolean;
	}) => DecideResult;
	table: CandidateTable;
	// W142 knowledge aids: the metering ledger, the preseed builder, and the
	// policy slice that gates them (routing-policy.yaml `aids:` block)
	aids: AidsLedger;
	preseeder: Preseeder;
	aidsPolicy: AidsPolicy;
	// W4 intent expansion — optional so bare deps (testDeps, dev) skip the
	// expand aid honestly instead of failing the wire path.
	expander?: Expander;
	// W5 prompt pipeline IN: the condense sidestore (pipeline.ts). Optional —
	// bare deps (testDeps, dev) skip honestly and the routes 404 (AppDeps law).
	pipeline?: CondenseStore;
	// W207 trajectory pruning: the diet sidestore (diet.ts). Optional — bare
	// deps (testDeps, dev) skip honestly and the routes 404 (AppDeps law).
	diet?: DietStore;
	// W154 federation surface — present on hub-shaped deps (buildDeps);
	// optional so bare deps (testDeps, dev) 404 honestly.
	federation?: Federation;
	// W7 repo-policy gate: the loaded rows (absent/empty = engine inert);
	// the route 404s honestly when unwired.
	repoPolicy?: RepoPolicyRow[];
	// W237 prefix-affinity: the prefix → candidate memo. Optional — bare
	// deps (testDeps, dev) route without affinity and the seam no-ops.
	affinity?: PrefixAffinity;
	// W458.4 per-lane cache telemetry: the append-only NDJSON lane log.
	// Optional — bare deps (testDeps, dev) skip lane rows honestly.
	laneCache?: LaneTelemetryLog;
	// W926 miss classification: per-boundary+lane prefix-fingerprint
	// references. Optional — unwired rows carry null prefix_fp/null
	// miss_cause (unknown, never guessed).
	prefixLedger?: PrefixLedger;
	// W450 bounded RPC admission: in-flight slot bound over the proxy path.
	// Optional — bare deps (testDeps, dev) admit unbounded (current shape).
	admission?: RpcAdmission;
	/** Injection seam for the 120s ingress body deadline. */
	ingressBodyTimeoutMs?: number;
	// W461 stage 2: the bounded observation outbox. Optional — absent =
	// observations inert (bare deps, or BUCKLE_OBSERVATIONS_PATH unset).
	observations?: ObservationOutbox;
	// W706: this hub's stable id (BUCKLE_HUB_ID) — the peer/origin identity
	// stamped on relay legs + observations. Absent → "local".
	hubId?: string;
}

interface App {
	fetch(req: Request): Promise<Response>;
}

/** Short request id — the audit join key echoed as x-belt-rid. */
function newRid(): string {
	return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const HEADERS_JSON = (h: Record<string, string>): Headers => {
	const out = new Headers();
	for (const [k, v] of Object.entries(h)) out.set(k, v);
	return out;
};

/** Stamp the W136 wire headers on a response without touching its body:
 *  x-belt-rid always; x-belt-route (single-line JSON: rid, target, decision,
 *  latency_class, tier) on every router-decided response; x-belt-error on
 *  errors. */
function stamped(
	resp: Response,
	ctx: Ctx,
	route: {
		decision: string;
		row?: CandidateRow;
		code?: string | null;
		refusal?:
			| "buckle"
			| "upstream"
			| "bridged-upstream"
			| "network"
			| "cooldown";
		upstreamStatus?: number;
		attempts?: number;
		requestId?: string;
		callId?: string;
		upstreamKind?: string;
		transportTimeoutPhase?: TransportEvidence["timeoutPhase"];
	},
): Response {
	const payload: Record<string, unknown> = {
		rid: ctx.rid,
		decision: route.decision,
	};
	if (route.row) {
		payload.target = {
			kind: route.row.kind,
			host: route.row.host,
			port: route.row.port,
			model: route.row.model,
		};
		payload.latency_class = latencyClass(route.row.estimate_ms);
	}
	if (ctx.tier) payload.tier = ctx.tier;
	if (ctx.lane) payload.lane = ctx.lane;
	if (route.attempts !== undefined) payload.attempts = route.attempts;
	if (route.refusal) payload.refusal = route.refusal;
	const hs = HEADERS_JSON({
		"x-belt-rid": ctx.rid,
		"x-belt-route": JSON.stringify(payload),
		...(route.code ? { "x-belt-error": route.code } : {}),
	});
	stampHopHeaders(hs, {
		service: "buckle",
		hop: ctx.hop.peer ? "relay" : "ingress",
		traceId: ctx.trace.traceparent.split("-")[1],
		refusal: route.refusal,
		attempts: route.attempts,
		upstreamStatus: route.upstreamStatus,
		upstreamKind: route.upstreamKind,
		transportTimeoutPhase: route.transportTimeoutPhase,
		upstreamId: route.requestId,
		callId: route.callId,
	});
	for (const [k, v] of hs) resp.headers.set(k, v);
	resp.headers.delete(PREFER_HEADER);
	if (ctx.preference) resp.headers.set(PREFER_HEADER, ctx.preference);
	return resp;
}

/** Buckle-GENERATED error body: problem+json with the stable code in `code`
 *  (http-citizenship). Two documented exceptions: upstream pass-through
 *  errors ride the upstream's body verbatim (client-error), and mid-stream
 *  failures speak SSE (the status is already sent). */
export function errorResponse(
	status: number,
	why: string,
	code?: string | null,
): Response {
	return problem({
		status,
		code: code ?? `buckle.${PROBLEM_SLUGS[status] ?? "problem"}`,
		why: code ? `belt: ${code} — ${scrubText(why)}` : scrubText(why),
	});
}

/** W921 traffic kind: a request is READINESS traffic only when a
 *  root-authenticated principal carries the healthcheck's
 *  `x-klh-traffic: readiness` mark — a lane key (or any non-root
 *  credential) with that header stays inference, and root traffic
 *  without the mark stays inference too (break-glass stays honest).
 *  Gate-off posture (no principal) is never readiness. */
export function trafficKindOf(req: Request): string {
	if (req.headers.get("x-klh-traffic") !== "readiness") return "inference";
	return principalOf(req)?.kind === "root" ? "readiness" : "inference";
}

interface Ctx {
	key: string;
	group: string;
	model: string;
	dialect: Dialect;
	rid: string;
	/** W1 lane attribution: the /w/<slug> slug ('' on bare paths). */
	lane: string;
	hintRaw: string;
	hint: RouteHint | null;
	tier: string;
	t0: number;
	sel?: RouteSelection;
	/** W5: the request declared `condense-in` in its x-belt-aids stanza. */
	condenseIn: boolean;
	/** W237: packet-prefix key (null = no packet block, no affinity). */
	affKey: string | null;
	/** W926: keyed digest of the effective delivered prefix (post-alignment
	 *  body), null when the fingerprint ledger is unwired. */
	prefixFp: string | null;
	/** W450 bounded RPC admission: the slot release fn while this request's
	 *  upstream RPC is in flight (set in runExecute, released at drain). */
	slot?: () => void;
	/** W461 stage 1: request trace context (inbound traceparent or a fresh
	 *  root; baggage filtered to the fleet allowlist). */
	trace: TraceContext;
	/** W706: hop attribution — origin (self when entered here) + the
	 *  immediate peer (null = entered the fleet at this hub). */
	hop: HopContext;
	/** W921 traffic kind: 'readiness' when a ROOT-authenticated request
	 *  carries the x-klh-traffic: readiness mark (the healthcheck sidecar's
	 *  synthetic full-chain poll); 'inference' otherwise. */
	trafficKind: string;
	/** W1106: the request's abort signal — the honest downstream_cancel
	 *  evidence for stream receipts (Bun surfaces destination death lazily:
	 *  a pipeTo only rejects on the NEXT failed write, so a quiet abort
	 *  after the last chunk would otherwise bank as upstream_eof). */
	signal?: AbortSignal;
	/** Canonicalized executor intent; diagnostic only, never a route hint. */
	preference: string | null;
	/** W461 stage 2: set once the admitted observation is published —
	 *  ended events only ride admitted requests. */
	admitted?: boolean;
}

/** A refusal at the wire seam (bad hint, bad body): the denied audit row
 *  (denied audits too — W136 §6). */
function deny(
	deps: AppDeps,
	ctx: Ctx,
	status: number,
	why: string,
	code: string | null,
	decision: "denied" | "errored",
): Response {
	deps.ledger.auditDecision({
		rid: ctx.rid,
		trace_id: ctx.trace.traceparent.split("-")[1],
		ts: new Date().toISOString(),
		actor: ctx.key,
		lane: ctx.lane,
		dialect: ctx.dialect,
		hint: ctx.hintRaw,
		candidates_seen: 0,
		candidates_top: "",
		target_kind: null,
		target_host: null,
		target_port: null,
		target_model: null,
		decision,
		latency_class: "unproven",
		tier: ctx.tier,
		allow_cloud: false,
		error_code: code,
		why,
		hop: hopKindOf(ctx.hop),
		traffic_kind: ctx.trafficKind,
	});
	if (ctx.admitted)
		observe(deps, ctx, "lane.request.ended", { outcome: decision, status });
	deps.sm
		.counter(
			"buckle_refusals_total",
			"Proxy refusals by origin and HTTP status.",
		)
		.inc({ source: "buckle", status: String(status) });
	return auditAndStamp(deps, ctx, status, why, code, decision);
}

/** Outcome row + dialect envelope + stamped headers for a refusal. */
function auditAndStamp(
	deps: AppDeps,
	ctx: Ctx,
	status: number,
	why: string,
	code: string | null,
	decision: "denied" | "errored",
): Response {
	deps.ledger.auditOutcome(ctx.rid, {
		status,
		duration_ms: Date.now() - ctx.t0,
		ok: false,
		err: why,
	});
	const resp = errorResponse(status, why, code);
	return stamped(resp, ctx, { decision, code, refusal: "buckle", attempts: 0 });
}

async function proxy(
	req: Request,
	dialect: Dialect,
	path: string,
	deps: AppDeps,
	lane = "",
): Promise<Response> {
	const hubId = deps.hubId ?? "local";
	const baggage = allowlistedBaggage(req.headers.get("baggage"));
	const inboundHop = hopFromBaggage(baggage);
	const ctx: Ctx = {
		key: keyIdFromToken(tokenFromHeaders(req.headers)),
		group: "",
		model: "",
		dialect,
		rid: newRid(),
		lane: lane || (inboundHop.peer ? laneFromBaggage(baggage) : ""),
		hintRaw: "",
		hint: null,
		t0: 0,
		tier: "",
		condenseIn: false,
		affKey: null,
		prefixFp: null,
		preference: parsePreferHeader(req.headers.get(PREFER_HEADER)),
		// W461 stage 1: accept a caller traceparent, else root a fresh trace;
		// baggage survives only in the fleet-allowlisted subset. W706: the
		// hop marker rides the same baggage header — origin defaults to self
		// (the request entered the fleet here), peer = the forwarding hub.
		trace: {
			traceparent:
				parseTraceparent(req.headers.get("traceparent")) ?? newTraceparent(),
			baggage,
		},
		hop: {
			origin: inboundHop.origin || hubId,
			peer: inboundHop.peer,
		},
	};
	ctx.trafficKind = trafficKindOf(req);
	ctx.signal = req.signal;
	ctx.t0 = Date.now();
	const hint = hintFromHeaders(req.headers);
	if (!hint.ok) return deny(deps, ctx, 400, hint.why, "bad_hint", "denied");
	let body: Record<string, unknown>;
	try {
		body = (await readIngressJson(
			req,
			deps.ingressBodyTimeoutMs ?? INGRESS_BODY_TIMEOUT_MS,
			MAX_REQUEST_BODY_BYTES,
		)) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof IngressBodyError) {
			if (error.code === "timeout")
				return deny(
					deps,
					ctx,
					408,
					"request body deadline exceeded",
					"body_timeout",
					"denied",
				);
			if (error.code === "too_large")
				return deny(
					deps,
					ctx,
					413,
					"request body too large",
					"body_too_large",
					"denied",
				);
		}
		return deny(deps, ctx, 400, "invalid JSON body", null, "denied");
	}
	const model = typeof body.model === "string" ? body.model : "";
	if (model.length === 0)
		return deny(deps, ctx, 400, "missing model", null, "denied");
	// W461 stage 2: admitted — unsampled, published before any routing.
	ctx.admitted = true;
	observe(deps, ctx, "lane.request.admitted");
	const wire = await applyWireAids(
		deps,
		req.headers.get("x-belt-aids"),
		body,
		dialect,
		ctx.rid,
	);
	body = wire.body;
	ctx.condenseIn = wire.condenseIn;
	ctx.affKey = deps.affinity ? affKeyOf(body) : null;
	ctx.group = model;
	ctx.model = model;
	ctx.hint = hint.hint;
	ctx.hintRaw = hint.raw;
	ctx.tier = scoreComplexity(textFromMessages(body.messages)).tier;
	const sel = deps.decide({
		group: model,
		dialect,
		hint: ctx.hint,
		hintRaw: ctx.hintRaw,
		// count_tokens never bridges (openai wire has no count endpoint)
		allowCross: path !== "/v1/messages/count_tokens",
	});
	if (!sel.ok) {
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision: "errored", dialect });
		return deny(deps, ctx, 503, sel.err.why, sel.err.code, "errored");
	}
	ctx.sel = sel.sel;
	return runExecute(req, ctx, path, body, deps);
}

async function runExecute(
	req: Request,
	ctx: Ctx,
	path: string,
	body: Record<string, unknown>,
	deps: AppDeps,
): Promise<Response> {
	let sel = ctx.sel;
	if (!sel) return deny(deps, ctx, 503, "no selection", "no_route", "errored");
	// W237 prefix-affinity: a candidate bound to this packet prefix delivers
	// first (same provider identity → provider KV cache hit). Reorders the
	// selection only — never injects, never a must-hint, cooldown-benched
	// rows skipped; off or bare deps → zero touch.
	if (ctx.affKey && deps.affinity && affinityOn()) {
		const bound = deps.affinity.probe(ctx.affKey);
		const reordered = applyAffinity(sel, bound);
		const applied = reordered !== sel;
		ctx.sel = reordered;
		sel = reordered;
		deps.sm
			.counter(
				"buckle_route_affinity_total",
				"Prefix-affinity dispatch outcomes.",
			)
			.inc({
				outcome: bound === null ? "miss" : applied ? "hit" : "skip",
			});
	}
	deps.ledger.auditDecision({
		rid: ctx.rid,
		trace_id: ctx.trace.traceparent.split("-")[1],
		ts: new Date().toISOString(),
		actor: ctx.key,
		lane: ctx.lane,
		dialect: ctx.dialect,
		hint: ctx.hintRaw,
		candidates_seen: sel.seen,
		candidates_top: sel.top.join(","),
		target_kind: sel.head.kind,
		target_host: sel.head.host,
		target_port: sel.head.port,
		target_model: sel.head.model,
		decision: sel.decision,
		latency_class: latencyClass(sel.head.estimate_ms),
		tier: ctx.tier,
		allow_cloud: sel.prefs.allow_cloud,
		error_code: null,
		why: sel.why,
		hop: hopKindOf(ctx.hop),
		traffic_kind: ctx.trafficKind,
	});
	deps.table.inflight(sel.head.candidate_id, 1);
	// W450 bounded RPC admission: one slot per in-flight upstream RPC; past
	// the cap the gateway 429s + Retry-After (never queues blindly).
	if (deps.admission) {
		const release = deps.admission.tryAcquire(ctx.group);
		if (release === null) {
			deps.sm
				.counter(
					"buckle_admission_refusals_total",
					"Proxy requests refused at the in-flight bound.",
				)
				.inc({ group: ctx.group });
			const resp = deny(
				deps,
				ctx,
				429,
				`gateway at max in-flight for ${ctx.group} (${String(deps.admission.capOf(ctx.group))})`,
				"overloaded",
				"errored",
			);
			resp.headers.set("retry-after", String(deps.admission.retryAfterS));
			return resp;
		}
		ctx.slot = release;
	}
	// W768 gate-side cache emission: anthropic-native rows honor cache_control
	// (native prompt caching) — the gate aligns the stable prefix with no
	// client declaration. openai-compat rows (litellm/ZAI implicit caching,
	// copilot unknown) never receive markers; bridged hops strip them in the
	// body rebuild (adapters/tools.ts). count_tokens is never touched.
	const alignedBody = gateCacheAlign(
		deps,
		body,
		path !== "/v1/messages/count_tokens" &&
			resolveAdapter(sel.head.dep).family === "anthropic",
	);
	if (alignedBody) body = alignedBody;
	// W926: digest the EFFECTIVE prefix as delivered upstream — the
	// post-alignment body. Keyed + truncated: prompt bytes never logged.
	ctx.prefixFp = deps.prefixLedger ? prefixFingerprintOf(body) : null;
	let result: ExecuteResult;
	// W461 stage 2: started — the upstream dispatch begins.
	observe(deps, ctx, "lane.request.started");
	try {
		result = await deps.router.execute({
			group: ctx.model,
			dialect: ctx.dialect,
			path,
			body,
			key: ctx.key,
			rid: ctx.rid,
			trace: ctx.trace,
			relayBaggage: hopBaggageOf(
				ctx.trace.baggage,
				deps.hubId ?? "local",
				ctx.lane,
			),
			preference: ctx.preference,
			signal: req.signal,
			sel,
			tier: ctx.tier,
			hintRaw: ctx.hintRaw,
		});
	} catch (e) {
		deps.table.inflight(sel.head.candidate_id, -1);
		ctx.slot?.(); // no upstream body will own the slot — release now
		if (e instanceof UpstreamError)
			return deny(deps, ctx, 502, e.message, "no_route", "errored");
		throw e;
	}
	let resp: Response;
	try {
		resp = await handleResult(deps, ctx, result);
	} catch (e) {
		ctx.slot?.(); // never leak a slot on a handler throw
		throw e;
	}
	return finishResponse(deps, ctx, sel, result, resp);
}

/** Stamps the delivered outcome onto the response + audit + EWMA.
 *  Delivered ≠ selected → decision "fallback" (delivery truth outranks
 *  ranking truth; W136 §7.6). */
function finishResponse(
	deps: AppDeps,
	ctx: Ctx,
	sel: RouteSelection,
	result: ExecuteResult,
	resp: Response,
): Response {
	let decision: DecisionKind = sel.decision;
	let row: CandidateRow | undefined = sel.head;
	let code: string | null = null;
	const rateLimited = result.kind === "client-error" && resp.status === 429;
	if (result.kind === "upstream") {
		row = deps.table.rowFor(result.candidateId) ?? sel.head;
		if (result.candidateId !== sel.head.candidate_id) decision = "fallback";
	} else if (result.kind === "exhausted") {
		decision = "errored";
		code = "no_route";
	} else if (result.kind === "aborted") {
		decision = "errored";
	}
	if (rateLimited) {
		decision = "errored";
		code = "rate_limited";
	}
	const ms = Date.now() - ctx.t0;
	const ok =
		result.kind === "upstream" ||
		(result.kind === "client-error" && !rateLimited);
	const streaming =
		result.kind === "upstream" && result.stream && !!result.response.body;
	if (!streaming) {
		deps.table.inflight(sel.head.candidate_id, -1);
		ctx.slot?.();
	}
	const winner =
		result.kind === "upstream" ? result.candidateId : sel.head.candidate_id;
	if (!streaming)
		deps.table.recordOutcome(winner, ms, result.kind === "upstream");
	// W237: the delivered candidate owns this prefix for the TTL window.
	if (
		result.kind === "upstream" &&
		!streaming &&
		ctx.affKey &&
		deps.affinity &&
		affinityOn()
	)
		deps.affinity.bind(ctx.affKey, result.candidateId);
	if (!streaming)
		deps.ledger.auditOutcome(ctx.rid, {
			status: resp.status,
			duration_ms: ms,
			ok,
			// W824: the ladder walk length at settle (null on aborted walks —
			// the union kind without an attempts field).
			attempts: result.kind === "aborted" ? null : result.attempts,
			err: rateLimited
				? "rate_limited"
				: result.kind === "exhausted"
					? result.error
					: null,
			...(rateLimited
				? { decision: "errored", error_code: "rate_limited" }
				: {}),
		});
	if (!streaming)
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision, dialect: ctx.dialect });
	// W461 stage 2: ended — the request settled (attempts/status on the
	// delivered outcome; streams that outlive this stay open-ended until
	// drain reconciliation, never faked as ended).
	if (ctx.admitted && !streaming)
		observe(deps, ctx, "lane.request.ended", {
			outcome: decision,
			status: resp.status,
			attempts: result.kind === "upstream" ? result.attempts : undefined,
		});
	const refusal =
		result.kind === "client-error"
			? result.refusalSource
			: result.kind === "exhausted"
				? (result.lastFailure?.source ?? "buckle")
				: result.kind === "aborted"
					? "buckle"
					: undefined;
	if (refusal)
		deps.sm
			.counter(
				"buckle_refusals_total",
				"Proxy refusals by origin and HTTP status.",
			)
			.inc({ source: refusal, status: String(resp.status) });
	return stamped(resp, ctx, {
		decision,
		row,
		code,
		refusal,
		attempts: result.kind === "aborted" ? 0 : result.attempts,
		upstreamStatus:
			result.kind === "exhausted" && result.lastFailure?.source !== "network"
				? result.lastFailure?.status
				: result.kind === "client-error" && result.refusalSource === "upstream"
					? result.response.status
					: undefined,
		requestId:
			result.kind === "exhausted"
				? result.lastFailure?.requestId
				: result.kind === "client-error"
					? (result.response.headers.get("x-klh-upstream-request-id") ??
						undefined)
					: undefined,
		callId:
			result.kind === "exhausted"
				? result.lastFailure?.callId
				: result.kind === "client-error"
					? (result.response.headers.get("x-litellm-call-id") ?? undefined)
					: undefined,
		transportTimeoutPhase:
			result.kind === "exhausted"
				? result.lastFailure?.transportTimeoutPhase
				: null,
		upstreamKind:
			result.kind === "exhausted"
				? result.lastFailure?.kind
				: result.kind === "client-error"
					? result.failureKind
					: undefined,
	});
}

function handleResult(
	deps: AppDeps,
	ctx: Ctx,
	result: ExecuteResult,
): Response | Promise<Response> {
	if (result.kind === "aborted") return new Response(null, { status: 499 });
	if (result.kind === "exhausted") {
		const deferred = result.status === 503 && result.retryAfterS !== undefined;
		const walkDeadline = result.lastFailure?.kind === "walk_deadline";
		const response = errorResponse(
			walkDeadline ? 504 : deferred ? 503 : 502,
			result.error,
			"no_route",
		);
		if (deferred)
			response.headers.set("retry-after", String(result.retryAfterS));
		return response;
	}
	if (result.kind === "client-error") {
		// the upstream rejected the request — its error body is the most
		// informative answer for the client; no ledger row (nothing proxied).
		// A 429 is the UPSTREAM's budget, never buckle's: its limit headers
		// ride renamed x-upstream-ratelimit-* so clients never confuse whose
		// budget fired (proxy precedence law).
		const headers = SSE_HEADERS(result.response.headers);
		if (result.response.status === 429) {
			for (const [k, v] of result.response.headers) {
				const lk = k.toLowerCase();
				if (!lk.startsWith("x-ratelimit-") && !lk.startsWith("ratelimit-"))
					continue;
				headers.set(
					`x-upstream-ratelimit-${lk.replace(/^(x-)?ratelimit-/, "")}`,
					v,
				);
			}
		}
		return new Response(result.response.body, {
			status: result.response.status,
			headers,
		});
	}
	if (!result.stream) return jsonResponse(deps, ctx, result);
	return streamResponse(deps, ctx, result);
}

/** Route dispatch; servicemon instruments at the server seam. */
export function createApp(deps: AppDeps): App {
	async function fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		const method = req.method;
		// http-citizenship: introspection from the one route table (the gate
		// answers pre-auth when enabled; this covers BUCKLE_AUTH=off + tests).
		if (method === "OPTIONS") {
			const allow = allowOf(path);
			if (allow !== null) return options204(allow);
		}
		// W1 lane attribution (caveman adopt 1): /w/<slug> prefixes the LLM
		// ingress + /v1/models only. The slug lands in the audit row + the
		// x-belt-route header; the upstream sees the bare path. Other
		// surfaces (federation/admin/aids) stay unprefixed — a lane prefix
		// never widens surface.
		const laneRoute = lanePrefixOf(path);
		if (laneRoute.lane !== "") {
			const inner = laneRoute.path;
			const ingress =
				inner === "/v1/chat/completions" ||
				inner === "/v1/messages" ||
				inner === "/v1/messages/count_tokens" ||
				inner === "/v1/responses" ||
				inner === "/v1/models";
			if (method === "OPTIONS" && ingress)
				return options204(allowOf(inner) ?? "OPTIONS");
			if (method === "GET" && inner === "/v1/models") return models(deps);
			if (method === "POST" && inner === "/v1/chat/completions")
				return proxy(req, "openai", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/responses")
				return proxy(req, "openai", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages/count_tokens")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (ingress) return methodNotAllowed(inner);
			return problem({
				status: 404,
				code: "buckle.no_route",
				why: `no route: ${method} ${path}`,
			});
		}
		if (method === "GET" && path === "/v1/models") return models(deps);
		if ((method === "GET" || method === "HEAD") && path === "/health") {
			// Compatibility liveness only; outside-process probes own health.
			return new Response(method === "HEAD" ? null : "ok", {
				headers: { "content-type": "text/plain", "cache-control": "no-store" },
			});
		}

		if (method === "GET" && path === "/.well-known/jwks.json") {
			// W193: public JWKS — spokes fetch the manifest-signing public key
			// pre-cred; bare deps 404 honestly (the AppDeps contract).
			if (!deps.federation?.signer)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return Response.json(deps.federation.signer.jwks());
		}
		if (path.startsWith("/federation")) {
			// bare deps 404 honestly (the AppDeps contract)
			if (!deps.federation)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return deps.federation.handle(req, principalOf(req));
		}
		if (method === "GET" && path === "/v1/fleet/whoami") {
			// W607: self-verify echo for GUI fleet readers — the presented
			// bearer IS the credential (no admin needed). The gate already
			// authenticated + scope-checked (proxy GET → buckle:proxy:READ_);
			// 200 means the key is live, and the echo carries the identity
			// (key_id, scopes) the fleet-mcp server audits + enforces.
			const p = principalOf(req);
			return Response.json(
				p === null
					? { authenticated: false, reason: "gate off or anonymous" }
					: {
							authenticated: true,
							kind: p.kind,
							key_id: p.keyId,
							team: p.team,
							actor: p.actor,
							scopes: p.scopes,
						},
			);
		}
		const aidsRouted = await aidsRoutes(deps, req, path);
		if (aidsRouted) return aidsRouted;
		const pipeRouted = await pipelineRoutes(deps, req, path);
		if (pipeRouted) return pipeRouted;
		const dietRouted = await dietRoutes(deps, req, path);
		if (dietRouted) return dietRouted;
		const rpRouted = await repoPolicyRoutes(
			{ rows: deps.repoPolicy ?? [], sm: deps.sm },
			req,
			path,
		);
		if (rpRouted) return rpRouted;
		if (method === "POST" && path === "/v1/chat/completions") {
			return proxy(req, "openai", path, deps);
		}
		// W912: the OpenAI Responses ingress — same openai dialect, the path
		// forwards verbatim (responses-only models are NEVER re-targeted at
		// chat completions; other-dialect hops are ineligible by bridge law).
		if (method === "POST" && path === "/v1/responses") {
			return proxy(req, "openai", path, deps);
		}
		if (method === "POST" && path === "/v1/messages/count_tokens") {
			return proxy(req, "anthropic", path, deps);
		}
		if (method === "POST" && path === "/v1/messages") {
			return proxy(req, "anthropic", path, deps);
		}
		// known path, wrong method → 405 + Allow (admin paths stay 404 here —
		// the gate routes them post-auth, where handleAdmin answers 405).
		if (allowOf(path) !== null && !path.startsWith("/v1/admin")) {
			return methodNotAllowed(path);
		}
		return problem({
			status: 404,
			code: "buckle.no_route",
			why: `no route: ${method} ${path}`,
		});
	}
	return { fetch };
}

function models(deps: AppDeps): Response {
	const data = deps.pool
		.groups()
		.filter((id) => deps.pool.deployments(id).length > 0)
		.map((id) => ({ id, object: "model", owned_by: "buckle" }));
	return Response.json({ object: "list", data });
}
