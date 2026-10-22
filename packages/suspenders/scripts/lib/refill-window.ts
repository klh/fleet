// Plaid grows sequentially, with a measured gap between launches. There is
// no numeric lane ceiling; route health and quota observations stop growth.
import {
	dispatchHoldActive,
	dispatchHoldGate,
} from "../../hooks/lib/dispatch-hold.ts";
import type { Posture } from "../../hooks/lib/plaid.ts";

export type RefillWindow = {
	/** Null means no total lane target. */
	target: number | null;
	/** Current rate-limit evidence pauses Plaid until a later cycle. */
	paused: boolean;
};

/** Rollout hold is explicit state, kept separate from recovery and live lanes. */
export const dispatchHeld = (fleetDir: string): boolean =>
	dispatchHoldActive(fleetDir) !== null;

// W1196: the hold surface itself lives in hooks/lib/dispatch-hold.ts — the
// re-export keeps the dispatch-next import path and hands the WAIT gate to
// the one module that names the holder and the expiry.
export { dispatchHoldGate };

/** Operator may slow launches further, but cannot set a stampede interval. */
export const plaidLaunchGapMs = (raw?: string): number => {
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= 5_000 && parsed <= 60_000
		? parsed
		: 10_000;
};

/** Return control before the fleet-loop's 15-minute cycle watchdog fires. */
export const plaidCycleOpen = (startedAt: number, now: number): boolean =>
	now - startedAt < 12 * 60_000;

export const refillWindow = (
	posture: Posture,
	steadyTarget: number,
	live: number,
	rateLimitWalls: number,
): RefillWindow => {
	if (posture === "plaid") return { target: null, paused: rateLimitWalls > 0 };
	const target =
		rateLimitWalls > 0
			? Math.max(1, Math.ceil((steadyTarget * live) / (live + rateLimitWalls)))
			: steadyTarget;
	return { target, paused: false };
};

export const canAttemptRefill = (
	window: RefillWindow,
	occupied: number,
): boolean =>
	!window.paused && (window.target === null || occupied < window.target);
