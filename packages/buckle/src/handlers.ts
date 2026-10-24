import type { TransportEvidence } from "../../telemetry/src/transport-evidence.ts";
// src/handlers.ts — wire handlers: the two ingress dialects (POST
// /v1/chat/completions openai-shape, POST /v1/messages anthropic-shape) plus
// /v1/messages/count_tokens and GET /v1/models. SSE responses pass through
// byte-identical (tee, never re-serialized); usage is sniffed from the
// terminal events per the W129 contract (streaming_handler.py semantics,
// MIT port). Errors follow the ingress dialect's error shape; unknown-usage
// streams record requests without token columns — honest omission, never
// estimated.

import {
	safeFailureKind,
	stampHopHeaders,
} from "../../telemetry/src/http-trace.ts";
import {
	PREFER_HEADER,
	parsePreferHeader,
} from "../../telemetry/src/prefer-header.ts";
import { RouterError, routerErrorEnvelope } from "./adapters/errors.ts";
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
import { boundaryKey, boundaryOfDeployment } from "./cache-boundary.ts";
import {
	type MissCause,
	type PrefixLedger,
	prefixFingerprintOf,
} from "./cache-fingerprint.ts";
import type { CandidateRow, CandidateTable } from "./candidates.ts";
import {
	allowOf,
	lanePrefixOf,
	methodNotAllowed,
	options204,
	problem,
} from "./citizenship.ts";
import { errorResponse, scrubText } from "./error-response.ts";
import { scoreComplexity, textFromMessages } from "./complexity.ts";
import {
	type DecideResult,
	type DecisionKind,
	latencyClass,
	type RouteSelection,
} from "./decide.ts";
import { type DietStore, dietRoutes } from "./diet.ts";
import { onDrain, writeDrainTerminal } from "./drain.ts";
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
	beginInflight,
	endInflight,
	markInflight,
	settleInflight,
} from "./gov/inflight.ts";
import {
	INGRESS_BODY_TIMEOUT_MS,
	IngressBodyError,
	MAX_REQUEST_BODY_BYTES,
	readIngressJson,
} from "./ingress-body.ts";
import { keyIdFromToken, type Ledger, tokenFromHeaders } from "./ledger.ts";
import type {
	ObservationData,
	ObservationOutbox,
	ObservationType,
} from "./observe.ts";
import { type CondenseStore, pipelineRoutes } from "./pipeline.ts";
import { condenseInbound } from "./pipeline-wire.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Preseeder } from "./preseed.ts";
import type { RepoPolicyRow } from "./repo-policy.ts";
import { repoPolicyRoutes } from "./repo-policy-routes.ts";
import { type ExecuteResult, type Router, UpstreamError } from "./router.ts";
import type { Servicemon } from "./servicemon.ts";
import { SseSniffer, sseReframer } from "./sse.ts";
import {
	allowlistedBaggage,
	newTraceparent,
	parseTraceparent,
	type TraceContext,
} from "./trace.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";
import {
	cacheUsageReported,
	cacheWriteReported,
	type Usage,
	usageFromAnthropic,
	usageFromOpenAI,
} from "./usage.ts";

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

const SSE_HEADERS = (h: Headers): Headers => {
	const out = new Headers();
	for (const [k, v] of h) {
		if (
			k === "content-length" ||
			k === "transfer-encoding" ||
			k === "connection"
		)
			continue;
		out.set(k, v);
	}
	return out;
};

const enc = new TextEncoder();

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
		streaming?: boolean;
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
	settleInflight(ctx, resp, route); // W1259: hold streams, settle the rest
	return resp;
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

/** W461 stage 2: publish one lane observation for this request. Inert
 *  unless the outbox is wired (BUCKLE_OBSERVATIONS_PATH). */
function observe(
	deps: AppDeps,
	ctx: Ctx,
	type: ObservationType,
	extra?: Partial<ObservationData>,
): void {
	deps.observations?.emit(type, {
		rid: ctx.rid,
		lane: ctx.lane,
		actor: ctx.key,
		dialect: ctx.dialect,
		model: ctx.model,
		traceparent: ctx.trace.traceparent,
		origin: ctx.hop.origin,
		...(ctx.hop.peer ? { peer: ctx.hop.peer } : {}),
		...extra,
	});
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
	beginInflight(ctx); // W1259: the exact in-flight index starts here
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
	markInflight(ctx); // W1259: model + selected upstream visible mid-flight
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
		streaming,
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

async function jsonResponse(
	deps: AppDeps,
	ctx: Ctx,
	result: Extract<ExecuteResult, { kind: "upstream" }>,
): Promise<Response> {
	const raw = new Uint8Array(await result.response.arrayBuffer());
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		// unparseable ok-body: record the request, no usage columns
	}
	let usage: Usage | null = null;
	let cacheReported = false;
	let writeReported = false;
	if (parsed !== null && typeof parsed === "object") {
		const u = (parsed as Record<string, unknown>).usage;
		cacheReported = cacheUsageReported(ctx.dialect, u);
		writeReported = cacheWriteReported(ctx.dialect, u);
		usage =
			ctx.dialect === "anthropic" ? usageFromAnthropic(u) : usageFromOpenAI(u);
	}
	record(deps, ctx, usage, cacheReported, writeReported);
	// W5 inbound condense: sidestore AFTER the ledger row; the response
	// bytes above are untouched (byte identity).
	condenseInbound(deps, ctx, parsed);
	return new Response(raw, {
		status: result.response.status,
		headers: SSE_HEADERS(result.response.headers),
	});
}

/** SSE pass-through with the usage-only tee: one branch flows to the client
 *  through the W616.1 sseReframer for anthropic clients (canonical frames,
 *  pings dropped, corrupt events quarantined — byte identity is amended:
 *  upstream framing defects must not reach lane clients), the other feeds
 *  the sniffer into a black hole. No re-route after first byte; an upstream
 *  death mid-stream appends a dialect error event and closes. */
function streamResponse(
	deps: AppDeps,
	ctx: Ctx,
	result: Extract<ExecuteResult, { kind: "upstream" }>,
): Response | Promise<Response> {
	const upstream = result.response;
	if (!upstream.body) return jsonResponse(deps, ctx, result);
	const sniffer = new SseSniffer(ctx.dialect);
	const [sniffBranch, clientBranch] = upstream.body.tee();
	// W1106 (#55505): ONE cancel bus — a Request abort AND a downstream
	// reader.cancel (direct body cancel, no Request signal) both feed it;
	// both pipes ride its signal so either path tears the tee + upstream
	// down and the receipt banks downstream_cancel, never a misattributed
	// upstream error.
	let streamCancelled = false;
	const downstreamAbort = new AbortController();
	const cancelDownstream = (): void => {
		streamCancelled = true;
		downstreamAbort.abort();
	};
	// W1156: the transform controller is captured so the drain can enqueue a
	// terminal straight into the client queue — the pipe keeps its own
	// writer; never fight it with a second one.
	let drainCtl: TransformStreamDefaultController<Uint8Array> | null = null;
	const downstream = new TransformStream<Uint8Array, Uint8Array>({
		start: (c) => {
			drainCtl = c;
		},
		cancel: () => cancelDownstream(),
	});
	// W1156: a positively-known deployment drain ends this stream with a
	// dialect-correct gateway_restarting terminal. Delivered marks truth —
	// only a terminal the client stream actually accepted re-banks the
	// receipt (a drain racing an already-closed/cancelled stream keeps the
	// real cause). A stream born mid-drain fires immediately.
	// W1106: declared ahead of the W1156 drain listener — a stream born
	// mid-drain fires that listener synchronously and it reads these.
	let streamFailed = false;
	let streamFailureKind: string | null = null;
	let streamDrained = false;
	/** W1156.1: has this stream already observed its real cause — an in-band
	 *  error frame (the client holds it), a terminal pipe failure, or the
	 *  dialect's protocol terminal? */
	const causeObserved = (): boolean =>
		streamFailed || sniffer.failureKind() !== null || sniffer.completed();
	const offDrain = onDrain(() => {
		// W1156.1: a stream that ALREADY observed its real failure keeps it.
		// The drain never appends a second, misleading gateway_restarting
		// after the real error the client already holds — it only cuts the
		// stream through the abort bus, and the receipt keeps the first
		// cause. A cause-free live stream still gets the restart terminal.
		if (causeObserved()) {
			// Close the client side WITHOUT a new frame — the real error the
			// client already holds stays the last error on the wire. The same
			// terminate() teardown as the terminal path: the readable closes
			// (clean EOF), the writable errors, and the pipe rejection is
			// recognized via streamDrained — never downstream_cancel.
			try {
				drainCtl?.terminate();
			} catch {
				// already closing/closed — the stream was already ending
			}
			streamDrained = true; // the drain cut it — never downstream_cancel
			downstreamAbort.abort();
			return;
		}
		streamDrained = writeDrainTerminal(drainCtl, ctx.dialect, ctx.rid);
		// A delivered cut tears the tee + upstream now (bounded grace), but
		// through the abort bus's pipes only — streamCancelled stays false so
		// the receipt keeps the drained cause, never downstream_cancel.
		if (streamDrained) downstreamAbort.abort();
	});
	// W1106: body-free stream progress counters — terminal receipts answer
	// "who closed this stream" without ever logging payload.
	let bytesIn = 0;
	let chunksIn = 0;
	let lastChunkMs: number | null = null;
	// W1106 (#55419/#55420): EOF without the dialect's protocol terminal
	// (anthropic message_stop / openai [DONE] / response.completed) is a
	// TRUNCATED turn — never a completed success.
	let streamTruncated = false;
	// W1106 (#55446/#55461): typed in-band failure from the body (anthropic
	// event:error, openai response.failed/incomplete) — non-success even
	// when a terminal marker follows. null = none seen.
	let streamInBand: string | null = null;
	const t0 = ctx.t0;
	const progress = (chunk: Uint8Array): void => {
		chunksIn++;
		bytesIn += chunk.byteLength;
		lastChunkMs = Date.now() - t0;
	};
	const finish = once(() => {
		offDrain();
		sniffer.flush();
		// W1106 (#55419/#55420): the sniffer saw the full body — did the
		// dialect's protocol terminal arrive? A CLEAN EOF without it is a
		// truncated turn; a failed pipe keeps its failure kind as the cause
		// (the guard's deadline outranks the missing terminal), and an abort
		// never counts as truncation.
		// W1156: a drain terminal that cut a live turn short is the honest
		// non-success; a drain AFTER the dialect terminal is a cosmetic close
		// (the turn completed) and never re-labels the receipt.
		// W1156.1: gateway_restarting is the cause ONLY for a stream with no
		// earlier observed failure — an in-band error or pipe failure observed
		// before the drain outranks it in the durable receipt (first cause
		// wins, never overwritten by the later drain).
		const drainedCut =
			streamDrained &&
			!sniffer.completed() &&
			sniffer.failureKind() === null &&
			!streamFailed;
		streamTruncated =
			!sniffer.completed() && !streamCancelled && !streamFailed && !drainedCut;
		// W1106 (#55446/#55461): an IN-BAND failure (anthropic event:error /
		// openai response.failed|incomplete) is non-success even when a
		// terminal marker follows it.
		streamInBand = sniffer.failureKind();
		record(
			deps,
			ctx,
			sniffer.usage(),
			sniffer.cacheReported(),
			sniffer.cacheWriteReported(),
		);
		const selected = ctx.sel?.head.candidate_id;
		// W1106 (#55344): a downstream cancel is a DISTINCT non-success —
		// ok:0/decision errored, no affinity bind, no candidate success
		// credit; the receipt's terminal carries downstream_cancel.
		const decision =
			streamFailed ||
			streamCancelled ||
			streamTruncated ||
			drainedCut ||
			streamInBand !== null
				? "errored"
				: result.candidateId === selected
					? (ctx.sel?.decision ?? "errored")
					: "fallback";
		const success =
			!streamFailed &&
			!streamCancelled &&
			!streamTruncated &&
			!drainedCut &&
			streamInBand === null;
		const duration = Date.now() - ctx.t0;
		if (selected) deps.table.inflight(selected, -1);
		deps.table.recordOutcome(result.candidateId, duration, success);
		if (success && ctx.affKey && deps.affinity && affinityOn())
			deps.affinity.bind(ctx.affKey, result.candidateId);
		deps.ledger.auditOutcome(ctx.rid, {
			// Headers have already been sent; ok/error_code carry the later
			// stream failure without pretending the HTTP status was 502.
			status: 200,
			duration_ms: duration,
			ok: success,
			attempts: result.attempts,
			err: streamCancelled
				? "downstream_cancel"
				: drainedCut
					? "gateway_restarting"
					: success
						? null
						: streamInBand !== null
							? `stream_failed:${streamInBand}`
							: streamTruncated
								? "stream_truncated"
								: `stream_failed:${streamFailureKind ?? "unknown"}`,
			...(success
				? {}
				: {
						decision: "errored",
						error_code: streamCancelled
							? "downstream_cancel"
							: drainedCut
								? "gateway_restarting"
								: streamInBand !== null
									? "stream_failed"
									: streamTruncated
										? "stream_truncated"
										: "stream_failed",
					}),
			stream_receipt: {
				terminal: terminalOf(
					streamFailed,
					streamFailureKind,
					streamCancelled,
					drainedCut,
					streamTruncated,
					streamInBand,
				),
				bytes_in: bytesIn,
				chunks_in: chunksIn,
				last_chunk_ms: lastChunkMs,
			},
		});
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision, dialect: ctx.dialect });
		if (ctx.admitted)
			observe(deps, ctx, "lane.request.ended", {
				outcome: decision,
				status: 200,
				attempts: result.attempts,
			});
		endInflight(ctx.rid, 200, success, decision, null); // W1259: stream settle
		ctx.slot?.(); // W450: the drain settled — the upstream slot frees
	});
	sniffBranch
		.pipeTo(blackHole(sniffer, progress), { signal: downstreamAbort.signal })
		.catch(() => {
			// the sniff branch failing (or aborting) must not affect the client
		});
	// W1106: a quiet abort never rejects the pipe on its own (real-Bun
	// probe — Bun surfaces destination death only on the next failed
	// write), so the request signal drives BOTH pipes: pipeTo cancels its
	// source when the signal fires, which tears the tee branches down and
	// with them the upstream body (#55399: a client walk must free the
	// in-flight upstream slot, not leak it). The rejections land in the
	// handlers above — no branch.cancel() from outside a locked pipe (#55409:
	// that rejects a promise try/catch never sees).
	if (ctx.signal?.aborted === true) cancelDownstream();
	else
		ctx.signal?.addEventListener(
			"abort",
			() => {
				if (!streamCancelled) cancelDownstream();
			},
			{ once: true },
		);
	// W616.1: every SSE client gets the re-framer — canonical frames, pings
	// dropped, corrupt events quarantined (litellm's keepalive ping splices
	// mid-line under load; byte-identity forwarded the defect to the lane).
	// W1106 (#56010): the reframer also carries the empty-stream guard for
	// BOTH dialects — a success terminal without usable output reaches the
	// native client as the typed in-band error, matching the ledger.
	const sanitized = clientBranch.pipeThrough(
		sseReframer(
			(reason, preview) => {
				deps.sm
					.counter(
						"buckle_sse_reframe_dropped_total",
						"SSE events dropped by the re-framer (ping keepalives, quarantined upstream framing defects).",
					)
					.inc({ reason });
				console.warn(`buckle: sse reframe dropped (${reason}): ${preview}`);
			},
			ctx.dialect,
			(kind) => {
				streamFailed = true;
				streamFailureKind = kind;
			},
		),
	);
	sanitized
		.pipeTo(downstream.writable, {
			preventAbort: true,
			signal: downstreamAbort.signal,
		})
		.then(finish, (err: unknown) => {
			// W1156: the drain cut itself terminates the transform (Bun has no
			// TransformStreamDefaultController.close), so this rejection IS the
			// drain's own signature — the terminal is already queued ahead of
			// the close. Keep the drained cause; classifying it as an upstream
			// failure would mislabel the receipt and double-write an error.
			if (streamDrained) {
				finish();
				return;
			}
			// W1106: classify BEFORE the receipt lands. The request signal is
			// the honest cancel evidence (real-Bun probe: pipeTo rejects
			// LAZILY — on the next failed write, or carrying the upstream's
			// own error object — so rejection identity cannot separate a
			// client abort from an upstream death). A downstream reader.cancel
			// rides the same bus via the TransformStream cancel hook (#55505).
			if (downstreamAbort.signal.aborted) {
				streamCancelled = true;
			} else {
				streamFailed = true;
				// W1106: RouterError.kind is the typed taxonomy (wire guards
				// throw RouterError "timeout" at their deadlines); telemetry's
				// safeFailureKind is generic and would bucket it "error".
				streamFailureKind =
					err instanceof RouterError ? err.kind : safeFailureKind(err);
			}
			finish();
			if (!streamCancelled)
				writeErrorEvent(downstream.writable, ctx.dialect, err);
		})
		.catch(() => {
			// W1106: the error-event write failed = the client is gone; the
			// receipt already banked the upstream failure — terminal stands.
		});
	// W1106: the SSE contract is ours — a classified stream whose provider
	// omitted or mislabeled content-type must still carry the exact MIME the
	// server.ts per-request idle bypass keys on (scoped HERE, never in the
	// shared helper: jsonResponse/client-error pass through other bodies).
	const headers = SSE_HEADERS(upstream.headers);
	headers.set("content-type", "text/event-stream");
	return new Response(downstream.readable, {
		status: 200,
		headers,
	});
}

/** W1106: typed stream terminal for the audit receipt — who ended the
 *  stream, from the body-free evidence at this hop. EOF without the
 *  dialect's protocol terminal banks upstream_eof_truncated (#55420); an
 *  in-band failure body outranks a terminal marker that follows (#55446). */
function terminalOf(
	failed: boolean,
	kind: string | null,
	cancelled: boolean,
	drained: boolean,
	truncated: boolean,
	inBand: string | null,
): string {
	if (cancelled) return "downstream_cancel";
	if (drained) return "gateway_restarting";
	if (inBand !== null) return `in_band_error:${inBand}`;
	if (!failed) return truncated ? "upstream_eof_truncated" : "upstream_eof";
	if (kind === "timeout") return "upstream_deadline";
	return `upstream_error:${kind ?? "unknown"}`;
}

/** Sink for the sniff branch: bytes in, usage extraction (+ the W1106
 *  progress counters), nothing out. */
function blackHole(
	sniffer: SseSniffer,
	progress?: (chunk: Uint8Array) => void,
): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			progress?.(chunk);
			sniffer.push(chunk);
		},
	});
}

/** Run fn once; later callers are no-ops (stream finalization guard). */
function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}

/** Mid-stream upstream death: append a dialect error event, close. */
function writeErrorEvent(
	writable: WritableStream<Uint8Array>,
	dialect: Dialect,
	err: unknown,
): void {
	const message = scrubText(
		err instanceof Error ? err.message : "upstream stream failed",
	);
	const w = writable.getWriter();
	const envelope =
		err instanceof RouterError
			? routerErrorEnvelope(err, dialect, message)
			: { error: { message, type: "api_error", code: "stream_failed" } };
	const body =
		dialect === "anthropic"
			? `event: error\ndata: ${JSON.stringify({ type: "error", ...envelope })}\n\n`
			: `data: ${JSON.stringify(envelope)}\n\n`;
	void w
		.write(enc.encode(body))
		.then(() => w.close())
		.catch(() => {
			// client already gone — nothing to write to
		});
}

/** One completed proxied request → ledger row + servicemon token counters.
 *  usage null = honest unknown: the requests column still increments, token
 *  columns contribute nothing, servicemon gets an explicit counter.
 *  W457: the same usage joins the per-request audit row (cache_r/cache_c —
 *  OpenAI cached_tokens / Anthropic cache_read + cache_creation); a null
 *  usage skips that join, so unobserved cache stays NULL, never zero-faked. */
function record(
	deps: AppDeps,
	ctx: Ctx,
	usage: Usage | null,
	cacheReported: boolean,
	cacheWriteReported: boolean,
): void {
	// W457 cache telemetry: joined onto the route_audit row by rid.
	deps.ledger.auditUsage(ctx.rid, usage, cacheReported, cacheWriteReported);
	// W458.4 per-lane cache telemetry: attributed lanes append the row with
	// the boundary the request actually rode (the delivered head). Usage
	// null = honest unknown — the request still counts, tokens stay zero.
	const head = ctx.sel?.head;
	if (ctx.lane && head && deps.laneCache) {
		const boundary = boundaryOfDeployment(head.dep, head.model);
		// W926 miss classification: a miss WITH a reported cache write is
		// comparable — the provider just wrote this exact prefix, so if the
		// banked reference equals it the earlier entry was dropped upstream
		// (provider-eviction); differing bytes = changed-prefix. Hits and
		// confirmed writes re-bank the reference; usage null, no write, or
		// unwired ledger stays null (unknown, never guessed).
		let miss: MissCause = null;
		if (
			deps.prefixLedger &&
			ctx.prefixFp &&
			usage &&
			usage.cache_r === 0 &&
			usage.cache_c > 0
		)
			miss = deps.prefixLedger.cause(
				boundaryKey(boundary),
				ctx.lane,
				ctx.prefixFp,
			);
		if (
			deps.prefixLedger &&
			ctx.prefixFp &&
			usage &&
			(usage.cache_r > 0 || usage.cache_c > 0)
		)
			deps.prefixLedger.observe(boundaryKey(boundary), ctx.lane, ctx.prefixFp);
		deps.laneCache.append({
			lane: ctx.lane,
			task: ctx.key,
			boundary,
			usage: usage ?? {
				in_tok: 0,
				out_tok: 0,
				cache_r: 0,
				cache_c: 0,
			},
			requests: 1,
			wallMs: Date.now() - ctx.t0,
			at: new Date().toISOString(),
			prefix_fp: ctx.prefixFp,
			miss_cause: miss,
		});
	}
	if (usage === null) {
		// honest unknown: count the request, contribute no token columns,
		// flag it on servicemon — never estimated, never faked as real zeros
		deps.sm
			.counter(
				"buckle_usage_unknown_total",
				"Proxied responses where usage could not be observed.",
			)
			.inc();
		deps.ledger.record({
			key: ctx.key,
			group: ctx.group,
			model: ctx.model,
			in_tok: 0,
			out_tok: 0,
			cache_r: 0,
			cache_c: 0,
			requests: 1,
		});
		return;
	}
	deps.ledger.record({
		key: ctx.key,
		group: ctx.group,
		model: ctx.model,
		in_tok: usage.in_tok,
		out_tok: usage.out_tok,
		cache_r: usage.cache_r,
		cache_c: usage.cache_c,
		requests: 1,
	});
	deps.sm.tokens("in", usage.in_tok);
	deps.sm.tokens("out", usage.out_tok);
	deps.sm.tokens("cache_read", usage.cache_r);
	deps.sm.tokens("cache_create", usage.cache_c);
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
