// src/proxy-body.ts — the non-streaming response body: usage sniff,
// ledger/servicemon record, W5 inbound condense; response bytes untouched.

import { stampHopHeaders } from "@klh/telemetry/src/http-trace.ts";
import { condenseInbound } from "./pipeline-wire.ts";
import type { Ctx } from "./request-context.ts";
import { record } from "./usage-record.ts";
import {
	cacheUsageReported,
	cacheWriteReported,
	type Usage,
	usageFromAnthropic,
	usageFromOpenAI,
} from "./usage.ts";
import { SSE_HEADERS } from "./wire-stamp.ts";
import type { AppDeps } from "./app-deps.ts";
import type { ExecuteResult } from "./router.ts";

export async function jsonResponse(
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
	const headers = SSE_HEADERS(result.response.headers);
	// Owner directive (Phase 0 trace round-trip): a caller that attaches a
	// trace id at the chain's start receives it BACK with hop annotations —
	// the shared emitter clears the owned headers first, so a hostile
	// upstream cannot forge x-klh-* through the success path either.
	stampHopHeaders(headers, {
		service: "buckle",
		traceId: ctx.trace.traceparent.slice(3, 35),
		requestId: ctx.rid,
	});
	return new Response(raw, {
		status: result.response.status,
		headers,
	});
}
