// src/resilience-config.ts — W-fork-F "fail fast, one retry layer, shared
// state" knobs: the `gateway.resilience` block of routing-policy.json,
// zod-validated (Schema law, W1238.4) and fail-closed at boot.
//
// Doctrine (owner corrections, 2026-10-29):
//   - buckle NEVER sleeps a request waiting for an upstream to recover; the
//     outermost client owns the one retry layer (honest 429/503 +
//     Retry-After, fast).
//   - one shared cold mark per upstream account: N callers → 1 knock.
//   - rate pressure (Z.ai 1302/1305, plain 429) = SHORT cold + smaller
//     pool concurrency (AIMD), never an outage and never a dispatch stop.
//   - only declared quota-wall codes (balance/plan exhaustion) = long cold
//     + the dispatch-stop signal. Unverified provider codes stay config.
import { z } from "zod";

const seconds = (max: number) => z.number().positive().max(max);

export const ResilienceConfigSchema = z
	.object({
		/** Cold window for a rate-shaped refusal with no Retry-After. */
		rate_cooldown_s: seconds(3600).default(5),
		/** Clamp on a rate-shaped refusal's Retry-After — rate pressure is
		 *  never a long outage. */
		rate_cooldown_max_s: seconds(3600).default(30),
		/** Cold window for a quota wall with no Retry-After. */
		quota_cooldown_s: seconds(86_400).default(900),
		/** Clamp on a quota wall's Retry-After (a days-long reset never parks
		 *  a client; the dispatch signal carries the stop instead). */
		quota_cooldown_max_s: seconds(86_400).default(3600),
		/** Provider codes that mean balance/plan exhaustion. Verified in-code:
		 *  Z.ai 1113 = insufficient balance (W1267). Usage-window codes are
		 *  operator config — never guessed here. */
		quota_wall_codes: z
			.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/))
			.max(32)
			.default(["1113"]),
		/** Cold expiry jitter: until = now + d·(1 + U[0, ratio)) so a herd
		 *  never wakes at once. */
		cooldown_jitter_ratio: z.number().min(0).max(1).default(0.2),
		/** A half-open probe that never reported is re-claimable after this. */
		probe_stale_s: seconds(3600).default(30),
		/** Immediate failover hops after an upstream HTTP refusal (429/5xx).
		 *  Cold rungs are skipped free; connect failures never count. */
		max_failover_hops: z.number().int().min(0).max(4).default(1),
		/** Fleet-wide cap on those hops: hops < max(min, ratio · requests)
		 *  per window, per requested group. */
		failover_budget: z
			.object({
				ratio: z.number().min(0).max(1).default(0.1),
				min_per_window: z.number().int().min(0).max(1000).default(5),
				window_s: seconds(3600).default(60),
			})
			.strict()
			.prefault({}),
		/** Outer clamp on any provider-pool queue wait — a short bounded
		 *  queue, never the multi-minute hold a pool policy may declare. */
		max_queue_wait_ms: z.number().int().min(0).max(60_000).default(5000),
		/** AIMD multiplicative decrease of a pool's in-flight window on a
		 *  rate-shaped refusal (additive increase stays the recovery path). */
		rate_concurrency_decrease_percent: z.number().int().min(0).max(90).default(50),
		/** Floor of that window. */
		min_concurrency: z.number().int().min(1).max(1024).default(1),
		/** Lane vs interactive traffic classes (by the key's mint NAME). */
		lanes: z
			.object({
				/** Mint names of fleet-dispatched lane keys (dispatch mints
				 *  name=sid; dispatched sids carry these prefixes). */
				key_name_pattern: z.string().max(256).default("^(auto|review|ramp)"),
				/** Share of a group's in-flight cap lanes may hold — the rest is
				 *  reserved so a lane flood never starves interactive sessions. */
				share: z.number().gt(0).max(1).default(0.75),
				/** Per-key token buckets (429 + Retry-After when empty). */
				lane_bucket: z
					.object({
						capacity: z.number().int().min(1).max(100_000).default(20),
						refill_per_s: z.number().positive().max(10_000).default(2),
					})
					.strict()
					.prefault({}),
				interactive_bucket: z
					.object({
						capacity: z.number().int().min(1).max(100_000).default(60),
						refill_per_s: z.number().positive().max(10_000).default(10),
					})
					.strict()
					.prefault({}),
			})
			.strict()
			.prefault({}),
	})
	.strict();

export type ResilienceConfig = z.infer<typeof ResilienceConfigSchema>;

/** The defaults — what an absent `gateway.resilience` block means. */
export const RESILIENCE_DEFAULTS: ResilienceConfig =
	ResilienceConfigSchema.parse({});

/** Parse the policy block; malformed config refuses boot with the
 *  prettified zod error (fail closed, never silently default). */
export function parseResilience(raw: unknown): ResilienceConfig {
	if (raw === undefined || raw === null) return RESILIENCE_DEFAULTS;
	const parsed = ResilienceConfigSchema.safeParse(raw);
	if (!parsed.success)
		throw new Error(
			`policy: gateway.resilience invalid — ${z.prettifyError(parsed.error)}`,
		);
	try {
		new RegExp(parsed.data.lanes.key_name_pattern);
	} catch {
		throw new Error(
			"policy: gateway.resilience.lanes.key_name_pattern is not a valid RegExp",
		);
	}
	return parsed.data;
}

/** Traffic class of a credential mint name: lane keys vs everything else
 *  (interactive sessions, root, unnamed). */
export function trafficClassOf(
	keyName: string | null | undefined,
	cfg: ResilienceConfig,
): "lane" | "interactive" {
	if (keyName === null || keyName === undefined || keyName === "")
		return "interactive";
	return new RegExp(cfg.lanes.key_name_pattern).test(keyName)
		? "lane"
		: "interactive";
}
