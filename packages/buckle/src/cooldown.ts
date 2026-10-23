// src/cooldown.ts — the two ported LiteLLM primitives the ladder needs:
// retry-after-aware backoff (utils.py::_calculate_retry_after semantics:
// upstream retry-after minimum — both delta-seconds and HTTP-date forms —
// max(provider floor, capped exponential 2**attempt) + U[0,1) jitter; the
// provider floor itself is capped at retry_after_cap_s — W695.6.1: a quota
// wall's retry-after (days) must not park the walk, the final 429 + its
// retry-after still relay to the client) and passive
// outlier ejection (allowed_fails consecutive failures bench a deployment
// for cooldown_time seconds; success resets the counter — cooldown_cache /
// cooldown_handlers semantics at fixed-policy scale).
import { parseRetryAfterS } from "../../telemetry/src/http-kit.ts";
import type { Deployment } from "./upstreams.ts";

/** Backoff delay in seconds before the next same-tier attempt. The provider
 *  floor never exceeds floorCapS (retry_after_cap_s) — a quota wall relays
 *  instead of parking the walk. */
export function retryDelayS(
	attempt: number,
	retryAfter: number | null,
	rng: () => number,
	capS: number,
	floorCapS: number,
): number {
	const cap = Number.isFinite(capS) ? Math.max(1, capS) : 8;
	const floorCap = Number.isFinite(floorCapS) ? Math.max(1, floorCapS) : 60;
	const backoff = Math.min(2 ** Math.max(0, Math.min(30, attempt)), cap);
	const random = rng();
	const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
	const providerFloor =
		retryAfter !== null && Number.isFinite(retryAfter)
			? Math.min(Math.max(0, retryAfter), floorCap)
			: 0;
	return Math.max(backoff, providerFloor) + jitter;
}

/** retry-after header value in delta seconds, honoring both forms LiteLLM
 *  accepts: delta-seconds and HTTP-date form. Parses via the shared kit
 *  (W1238.5) — one rule fleet-wide: negative/garbage hints are no hint. */
export function retryAfterS(
	h: Headers,
	now: () => number = Date.now,
): number | null {
	return parseRetryAfterS(h, now);
}

/** Consecutive-failure ejection state (allowed_fails: consecutive failures
 *  bench a deployment for the cooldown window; success resets). */
export class Cooldowns {
	private readonly fails = new Map<string, number>();
	private readonly until = new Map<string, number>();
	private readonly reasons = new Map<string, "rate_limited" | "other">();

	constructor(
		private readonly allowedFails: number,
		private readonly cooldownS: number,
		private readonly now: () => number = Date.now,
	) {}

	private static key(dep: Deployment): string {
		return `${dep.group}|${dep.url}`;
	}

	failure(dep: Deployment, reason: "rate_limited" | "other" = "other"): void {
		const k = Cooldowns.key(dep);
		const n = (this.fails.get(k) ?? 0) + 1;
		this.fails.set(k, n);
		if (n >= this.allowedFails) {
			this.until.set(k, this.now() + this.cooldownS * 1000);
			this.reasons.set(k, reason);
			this.fails.set(k, 0);
		}
	}

	/** An unreachable peer is absent now; no repeated model-size timeout is
	 * needed before its candidate is removed from the walk. */
	eject(dep: Deployment): void {
		const k = Cooldowns.key(dep);
		this.until.set(k, this.now() + this.cooldownS * 1000);
		this.reasons.set(k, "other");
		this.fails.set(k, 0);
	}

	remainingS(dep: Deployment): number | null {
		if (!this.benched(dep)) return null;
		return Math.max(
			1,
			Math.ceil(
				((this.until.get(Cooldowns.key(dep)) ?? this.now()) - this.now()) /
					1000,
			),
		);
	}

	success(dep: Deployment): void {
		const k = Cooldowns.key(dep);
		this.fails.set(k, 0);
		this.until.delete(k);
		this.reasons.delete(k);
	}

	/** Remaining ejection time only when a provider throttle caused it. */
	rateLimitRemainingS(dep: Deployment): number | null {
		if (!this.benched(dep)) return null;
		const k = Cooldowns.key(dep);
		if (this.reasons.get(k) !== "rate_limited") return null;
		return this.remainingS(dep);
	}

	benched(dep: Deployment): boolean {
		const until = this.until.get(Cooldowns.key(dep));
		if (until === undefined) return false;
		if (until <= this.now()) {
			const k = Cooldowns.key(dep);
			this.until.delete(k);
			this.reasons.delete(k);
			return false;
		}
		return true;
	}
}
