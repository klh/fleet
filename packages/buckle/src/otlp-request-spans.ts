// src/otlp-request-spans.ts — W2788: the two buckle settle points mapped
// onto OTLP spans. `buckle.proxy` lands at the wire-stamp settle (verdict,
// hop, model_group, lane, key name); `buckle.usage` lands at the usage
// record and parents on the proxy span. Key material never rides — the key
// NAME (trusted mint name) only. Inert when the exporter is off.
import { randomBytes } from "node:crypto";
import { otlpExporter } from "./otlp-export.ts";
import type { Ctx } from "./request-context.ts";
import type { Usage } from "./usage.ts";

// The proxy span id is minted on first touch: non-streaming bodies record
// usage BEFORE the stamp settles, streams after — either order parents.
const proxySpanIds = new WeakMap<Ctx, string>();
function proxySpanId(ctx: Ctx): string {
	let id = proxySpanIds.get(ctx);
	if (!id) {
		id = randomBytes(8).toString("hex");
		proxySpanIds.set(ctx, id);
	}
	return id;
}

export interface ProxyVerdict {
	decision: string;
	status: number;
	streaming?: boolean;
	attempts?: number;
	refusal?: string;
	code?: string | null;
	providerTarget?: string;
}

export function exportProxySpan(ctx: Ctx, v: ProxyVerdict): void {
	const ex = otlpExporter();
	if (!ex) return;
	ex.push({
		name: "buckle.proxy",
		traceparent: ctx.trace.traceparent,
		spanId: proxySpanId(ctx),
		startMs: ctx.t0,
		endMs: Date.now(),
		error: v.status >= 500,
		attrs: {
			"buckle.rid": ctx.rid,
			"buckle.hop": ctx.hop.peer ? "relay" : "ingress",
			"buckle.model_group": ctx.group,
			"gen_ai.request.model": ctx.model,
			"gen_ai.response.model": ctx.served?.model,
			"gen_ai.provider.name": ctx.served?.provider ?? v.providerTarget,
			"buckle.lane": ctx.lane || null,
			"buckle.key_name": ctx.acct?.keyName,
			"buckle.verdict": v.decision,
			"buckle.refusal": v.refusal,
			"buckle.error_code": v.code,
			"buckle.attempts": v.attempts,
			"buckle.streaming": v.streaming ?? false,
			"buckle.dialect": ctx.dialect,
			"http.response.status_code": v.status,
		},
	});
}

/** Usage settle: null usage = honest unknown, no span (never zero-faked). */
export function exportUsageSpan(ctx: Ctx, usage: Usage | null): void {
	const ex = otlpExporter();
	if (!ex || !usage) return;
	ex.push({
		name: "buckle.usage",
		traceparent: ctx.trace.traceparent,
		parentSpanId: proxySpanId(ctx),
		startMs: ctx.t0,
		endMs: Date.now(),
		error: false,
		attrs: {
			"buckle.rid": ctx.rid,
			"buckle.model_group": ctx.group,
			"buckle.lane": ctx.lane || null,
			"gen_ai.usage.input_tokens": usage.in_tok,
			"gen_ai.usage.output_tokens": usage.out_tok,
			"gen_ai.usage.cache_read.input_tokens": usage.cache_r,
			"gen_ai.usage.cache_creation.input_tokens": usage.cache_c,
		},
	});
}
