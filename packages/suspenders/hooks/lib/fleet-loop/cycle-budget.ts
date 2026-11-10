// W2952 — cycle budget: the merge/review cadence must stay near the
// configured `every` tick, so a cycle's work is bounded by min(every,
// watchdog) instead of serial maintenance + a big branch census eating the
// whole 15-min watchdog (2026-11-10: cycle produced no progress for the
// whole window and the stall watch killed it). Shares are exported
// constants (fleet law: knob ratchet — no env knob without a registry
// row), so an operator tunes cadence via the stack conf `everyS`, the one
// knob that already exists.
// Merge/maintenance get their own slice of the SAME total, so heavy
// maintenance can never starve merges (the 08:21→08:31 starvation) and a
// big census can never starve maintenance.

export interface CycleBudget {
	/** bounded work window: min(everyMs, watchdogMs - margin) */
	readonly totalMs: number;
	/** slice the merge/dispatch core may spend this cycle */
	readonly mergeMs: number;
	/** slice serial maintenance may spend this cycle */
	readonly maintenanceMs: number;
}

export interface BudgetTracker {
	/** ms left in a slice; negative never returned */
	remainingMs(): number;
	/** charge consumed time; clamps at 0 */
	charge(ms: number): void;
}

export const MERGE_SHARE = 0.5;
export const MAINT_SHARE = 0.25;
/** kept back from the watchdog so the kill timer never beats the budget */
export const WATCHDOG_MARGIN_MS = 15_000;
export function planCycleBudget(input: {
	everyMs: number;
	watchdogMs: number;
	marginMs?: number;
}): CycleBudget {
	const totalMs = Math.max(
		1,
		Math.min(
			input.everyMs,
			Math.max(1, input.watchdogMs - (input.marginMs ?? WATCHDOG_MARGIN_MS)),
		),
	);
	return {
		totalMs,
		mergeMs: Math.max(1, Math.floor(totalMs * MERGE_SHARE)),
		maintenanceMs: Math.max(1, Math.floor(totalMs * MAINT_SHARE)),
	};
}

export function tracker(initialMs: number): BudgetTracker {
	let remaining = initialMs;
	return {
		remainingMs: () => remaining,
		charge: (ms: number) => {
			remaining = Math.max(0, remaining - Math.max(0, ms));
		},
	};
}
