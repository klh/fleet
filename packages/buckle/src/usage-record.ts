// src/usage-record.ts — one completed proxied request → ledger row,
// servicemon token counters, per-lane cache telemetry (honest unknown).

import { boundaryKey, boundaryOfDeployment } from "./cache-boundary.ts";
import type { MissCause } from "./cache-fingerprint.ts";
import type { Ctx } from "./request-context.ts";
import type { Usage } from "./usage.ts";
import type { AppDeps } from "./app-deps.ts";

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
	// W1132: ctx.model names the model so the ledger prices at enqueue.
	deps.ledger.auditUsage(
		ctx.rid,
		usage,
		cacheReported,
		cacheWriteReported,
		ctx.model,
	);
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
