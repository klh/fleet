// src/handlers-settle.ts — the settlement face shared by both response
// bodies: header passthrough, error-text scrubbing, lane observations, the
// usage extraction off a JSON ok-body, and one completed proxied request →
// ledger rows + servicemon counters. Extracted from handlers.ts
// (W1238.6.2); the stream tee rides it via stream-handler.ts.
import type { ObservationData, ObservationType } from "./observe.ts";
import { boundaryKey, boundaryOfDeployment } from "./cache-boundary.ts";
import type { MissCause } from "./cache-fingerprint.ts";
import type { AppDeps, Ctx } from "./handlers.ts";
import { condenseInbound } from "./pipeline-wire.ts";
import type { ExecuteResult } from "./router.ts";
import {
	cacheUsageReported,
	cacheWriteReported,
	type Usage,
	usageFromAnthropic,
	usageFromOpenAI,
} from "./usage.ts";

/** The SSE response header set: hop-by-hop headers stripped, everything
 *  else passes through byte-identical. */
export const SSE_HEADERS = (h: Headers): Headers => {
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

/** /Users/<name> paths and key material never leave through an error. */
export function scrubText(text: string): string {
	return text.replace(/\/Users\/[^/\s'"]+/g, "~");
}

/** W461 stage 2: publish one lane observation for this request. Inert
 *  unless the outbox is wired (BUCKLE_OBSERVATIONS_PATH). */
export function observe(
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

/** Parse the JSON ok-body, extract its usage, settle the ledger row, and
 *  return the bytes byte-identical (the response body is never re-encoded). */
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
	return new Response(raw, {
		status: result.response.status,
		headers: SSE_HEADERS(result.response.headers),
	});
}

/** One completed proxied request → ledger row + servicemon token counters.
 *  usage null = honest unknown: the requests column still increments, token
 *  columns contribute nothing, servicemon gets an explicit counter.
 *  W457: the same usage joins the per-request audit row (cache_r/cache_c —
 *  OpenAI cached_tokens / Anthropic cache_read + cache_creation); a null
 *  usage skips that join, so unobserved cache stays NULL, never zero-faked. */
export function record(
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
