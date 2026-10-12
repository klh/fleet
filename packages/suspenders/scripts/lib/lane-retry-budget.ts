/** Launch count is independent of the clamped executor-chain index. */
export function nextLaneAttempt(previous?: number): number {
	if (previous === undefined) return 0;
	return Number.isSafeInteger(previous) && previous >= 0
		? previous + 1
		: Number.MAX_SAFE_INTEGER;
}

/** SUSPENDERS_LANE_MAX_ATTEMPTS: total launches, default 3 (range 1–100). */
export function laneAttemptLimit(value?: string): number {
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 && n <= 100 ? n : 3;
}
