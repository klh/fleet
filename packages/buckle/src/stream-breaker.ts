// src/stream-breaker.ts — W2266: terminal-SSE failure circuit breaker.
// The live 2026-10-29 ZAI incident: HTTP 200, then stream_failed:timeout /
// stream_truncated after 188 bytes — proxy-stream banks success=false into
// CandidateTable metrics, but nothing marks the row unhealthy, so configured
// priority keeps selecting the same failing deployment. This breaker shares
// the SAME Cooldowns instance the walk uses (healthy = !benched, so the
// decision path and the background rebuild both see the bench with zero new
// health surfaces), with its OWN failure counter and cooldown window —
// provider-neutral, config-over-code (stream_allowed_fails /
// stream_cooldown_time_s).
import type { Cooldowns } from "./cooldown.ts";
import type { Deployment } from "./upstreams.ts";

export interface StreamBreakerConfig {
	allowedFails: number;
	cooldownS: number;
	/** W2266: fired the moment a bench flips ON — the candidate table
	 *  rebuilds so the NEXT decision reads the fresh healthy column (the
	 *  background tick alone would leave the failing row heading for up
	 *  to one tick). */
	onChange?: () => void;
}

/** Config from the gateway policy — the ejection defaults carry over so an
 *  unconfigured operator keeps one posture. */
export function streamBreakerConfig(policy: {
	stream_allowed_fails?: number;
	stream_cooldown_time_s?: number;
	allowed_fails?: number;
	cooldown_time?: number;
}): StreamBreakerConfig {
	return {
		allowedFails: policy.stream_allowed_fails ?? policy.allowed_fails ?? 3,
		cooldownS: policy.stream_cooldown_time_s ?? policy.cooldown_time ?? 30,
	};
}

/** Why the receipt banked a terminal — the receipt's own distinction, not a
 *  reclassification: a downstream cancel is the client's, never the
 *  upstream's, and a drain cut is the gateway's own restart, not an
 *  upstream fault. Only upstream-attributed terminals count. */
export type StreamTerminal =
	| { kind: "failed"; failureKind: string | null }
	| { kind: "truncated" }
	| { kind: "in_band"; failureKind: string }
	| { kind: "downstream_cancel" }
	| { kind: "drain_cut" }
	| { kind: "completed" };

export class StreamBreaker {
	private readonly fails = new Map<string, number>();

	constructor(
		private readonly cooldowns: Cooldowns,
		private readonly config: StreamBreakerConfig,
	) {}

	/** A terminal SSE outcome on one deployment. Upstream-attributed
	 *  failures accumulate toward the bench; once benched the deployment is
	 *  unhealthy for the NEXT request (the stream that tripped it is
	 *  already over — never a mid-stream re-route). A completed stream is
	 *  the recovery reset; a downstream cancel / drain cut is neither. */
	terminal(dep: Deployment, terminal: StreamTerminal): void {
		switch (terminal.kind) {
			case "completed":
				this.success(dep);
				return;
			case "downstream_cancel":
			case "drain_cut":
				return;
			case "failed":
			case "truncated":
			case "in_band":
				break;
		}
		const k = `${dep.group}|${dep.url}`;
		const n = (this.fails.get(k) ?? 0) + 1;
		if (n >= this.config.allowedFails) {
			this.cooldowns.benchFor(dep, this.config.cooldownS);
			this.fails.set(k, 0);
			this.config.onChange?.();
		} else {
			this.fails.set(k, n);
		}
	}

	/** A clean completed stream resets the row's consecutive-failure count.
	 *  Only the breaker's own counter — never Cooldowns.success(): a bench
	 *  another lane's outcome set (a rate-limit wall) must ride out its full
	 *  window; this row's clean stream proves the stream path, nothing more.
	 *  Time expiry (benched() past its until) is the bench's only lift. */
	success(dep: Deployment): void {
		this.fails.delete(`${dep.group}|${dep.url}`);
	}
}
