// Local, explicitly approximate count for configured models whose upstream
// dialect has no native Anthropic count_tokens endpoint. This never calls an
// unsupported provider path and never records the estimate as billed usage.
import { tokensEstimate } from "./aids.ts";
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";
import { hopKindOf } from "./hop.ts";
import {
	type Ctx,
	observe,
	safeAuditPath,
	safeAuditToken,
} from "./request-context.ts";
import { stamped } from "./wire-stamp.ts";

export const CountTokensBodySchema = z
	.object({
		model: z.string().min(1),
		messages: z.array(z.unknown()),
	})
	.passthrough();

export function estimatedCountTokens(
	deps: AppDeps,
	ctx: Ctx,
	body: Record<string, unknown>,
): Response {
	const inputTokens = Math.max(
		1,
		tokensEstimate(Buffer.byteLength(JSON.stringify(body), "utf8")),
	);
	const started = new Date().toISOString();
	deps.ledger.auditDecision({
		rid: ctx.rid,
		requested_group: ctx.group,
		request_path: safeAuditPath(ctx.auditPath),
		allow_cross: ctx.auditAllowCross,
		provider_pin: safeAuditToken(ctx.auditProviderPin),
		trace_id: ctx.trace.traceparent.split("-")[1],
		ts: started,
		actor: ctx.key,
		lane: ctx.lane,
		dialect: ctx.dialect,
		hint: ctx.hintRaw,
		candidates_seen: ctx.sel?.seen ?? 0,
		candidates_top: ctx.sel?.top.join(",") ?? "",
		target_kind: null,
		target_host: null,
		target_port: null,
		target_model: null,
		decision: "local_estimate",
		latency_class: "unproven",
		tier: ctx.tier,
		allow_cloud: false,
		error_code: null,
		why: "configured model lacks a native count_tokens endpoint; bytes/4 estimate",
		hop: hopKindOf(ctx.hop),
		traffic_kind: ctx.trafficKind,
		repo_hash: ctx.acct?.repoHash ?? null,
		account_tier: ctx.acct?.tier ?? null,
		key_name: ctx.acct?.keyName ?? null,
	});
	deps.ledger.auditOutcome(ctx.rid, {
		status: 200,
		duration_ms: Date.now() - ctx.t0,
		ok: true,
		err: null,
	});
	if (ctx.admitted)
		observe(deps, ctx, "lane.request.ended", {
			outcome: "local_estimate",
			status: 200,
		});
	const response = Response.json({ input_tokens: inputTokens });
	response.headers.set("x-klh-token-count-method", "estimated-bytes-v1");
	return stamped(response, ctx, { decision: "local_estimate", attempts: 0 });
}
