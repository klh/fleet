// src/wire-deny.ts — wire-seam refusals: the denied audit row,
// servicemon counters, and the stamped dialect error envelope.

import type { AppDeps } from "./app-deps.ts";
import { errorResponse } from "./error-response.ts";
import { hopKindOf } from "./hop.ts";
import { observe, type Ctx } from "./request-context.ts";
import { stamped } from "./wire-stamp.ts";

/** A refusal at the wire seam (bad hint, bad body): the denied audit row
 *  (denied audits too — W136 §6). */
export function deny(
	deps: AppDeps,
	ctx: Ctx,
	status: number,
	why: string,
	code: string | null,
	decision: "denied" | "errored",
): Response {
	deps.ledger.auditDecision({
		rid: ctx.rid,
		requested_group: ctx.sel ? ctx.group : null,
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
		repo_hash: ctx.acct?.repoHash ?? null,
		account_tier: ctx.acct?.tier ?? null,
		key_name: ctx.acct?.keyName ?? null,
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
