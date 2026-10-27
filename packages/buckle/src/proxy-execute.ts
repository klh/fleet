// src/proxy-execute.ts — upstream execution: affinity reorder, admission
// slot, cache-align, router execute, and the delivered-outcome settlement.

import { resolveAdapter } from "./adapters/index.ts";
import { affinityOn, applyAffinity } from "./affinity.ts";
import { gateCacheAlign } from "./aids-routes.ts";
import type { AppDeps } from "./app-deps.ts";
import { prefixFingerprintOf } from "./cache-fingerprint.ts";
import type { CandidateRow } from "./candidates.ts";
import {
	type DecisionKind,
	latencyClass,
	type RouteSelection,
} from "./decide.ts";
import { errorResponse } from "./error-response.ts";
import { markInflight } from "./gov/inflight.ts";
import { hopBaggageOf, hopKindOf } from "./hop.ts";
import { clampRetryAfter } from "./http-kit.ts";
import { jsonResponse } from "./proxy-body.ts";
import { streamResponse } from "./proxy-stream.ts";
import { type Ctx, observe } from "./request-context.ts";
import { type ExecuteResult, UpstreamError } from "./router.ts";
import { requestedEffort, servedIdentity } from "./served-identity.ts";
import { deny } from "./wire-deny.ts";
import { SSE_HEADERS, stamped } from "./wire-stamp.ts";

export async function runExecute(
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
		requested_group: ctx.group,
		requested_effort: requestedEffort(body),
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
		repo_hash: ctx.acct?.repoHash ?? null,
		account_tier: ctx.acct?.tier ?? null,
		key_name: ctx.acct?.keyName ?? null,
	});
	deps.table.inflight(sel.head.candidate_id, 1);
	markInflight(ctx); // W1259: model + selected upstream visible mid-flight
	// W450 bounded RPC admission: one slot per in-flight upstream RPC; past
	// the cap the gateway answers a typed local 503 + Retry-After (never
	// queues blindly, never fabricates the provider's 429 — W1257).
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
				503,
				`gateway at max in-flight for ${ctx.group} (${String(deps.admission.capOf(ctx.group))}) — admission refused locally (W450)`,
				"overloaded",
				"errored",
			);
			resp.headers.set(
				"retry-after",
				String(clampRetryAfter(deps.admission.retryAfterS)),
			);
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
	ctx.demand = (deps.admission?.inflight(ctx.group) ?? 0) > 1;
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
			hopContract: ctx.hopContract,
			ownRung: ctx.hopContract?.ownRung,
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
	if (result.kind === "upstream")
		ctx.served = servedIdentity(result.deployment, result.response.headers);
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
			served: ctx.served,
			demand: ctx.demand,
			status: resp.status,
			duration_ms: ms,
			ok,
			// W1124.42.1: the walk's real length even on a cancellation — the
			// hangup never erases the attempts it interrupted.
			attempts: result.attempts,
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
		attempts: result.attempts,
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
			response.headers.set(
				"retry-after",
				// W1303.2 clamp: a provider quota wall's weeks-long retry-after
				// used to relay verbatim and slept clients for weeks.
				String(clampRetryAfter(result.retryAfterS ?? 0)),
			);
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
