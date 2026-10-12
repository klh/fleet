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
 *  accepts: delta-seconds and HTTP-date form. */
export function retryAfterS(
	h: Headers,
	now: () => number = Date.now,
): number | null {
	const raw = h.get("retry-after");
	if (raw === null) return null;
	const delta = Number(raw);
	if (Number.isFinite(delta)) return Math.max(0, delta);
	const at = Date.parse(raw);
	if (Number.isFinite(at)) return Math.max(0, (at - now()) / 1000);
	return null;
}

/** Consecutive-failure ejection state (allowed_fails: consecutive failures
 *  bench a deployment for the cooldown window; success resets). */
export class Cooldowns {
	private readonly fails = new Map<string, number>();
	private readonly until = new Map<string, number>();

	constructor(
		private readonly allowedFails: number,
		private readonly cooldownS: number,
		private readonly now: () => number = Date.now,
	) {}

	private static key(dep: Deployment): string {
		return `${dep.group}|${dep.url}`;
	}

	failure(dep: Deployment): void {
		const k = Cooldowns.key(dep);
		const n = (this.fails.get(k) ?? 0) + 1;
		this.fails.set(k, n);
		if (n >= this.allowedFails) {
			this.until.set(k, this.now() + this.cooldownS * 1000);
			this.fails.set(k, 0);
		}
	}

	success(dep: Deployment): void {
		this.fails.set(Cooldowns.key(dep), 0);
	}

	benched(dep: Deployment): boolean {
		const until = this.until.get(Cooldowns.key(dep));
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.until.delete(Cooldowns.key(dep));
			return false;
		}
		return true;
	}
}
