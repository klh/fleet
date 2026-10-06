/** Evidence identity and expiry are independent of the target's state. */
export type ObservationKind =
	| "http-check"
	| "tcp"
	| "process"
	| "supervisor"
	| "ledger";
export interface Observation {
	source: string;
	target: string;
	scope: string;
	kind: ObservationKind;
	observedAt: number;
	expiresAt: number;
}
export function observation(
	source: string,
	target: string,
	scope: string,
	now: number,
	ttlMs: number,
	kind: ObservationKind,
): Observation {
	if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0)
		throw new Error("Invalid observation time or expiry");
	return {
		source,
		target,
		scope,
		kind,
		observedAt: now,
		expiresAt: now + ttlMs,
	};
}
export function observationFresh(
	value: Observation | null | undefined,
	now = Date.now(),
): boolean {
	return (
		!!value &&
		Number.isFinite(value.observedAt) &&
		Number.isFinite(value.expiresAt) &&
		value.observedAt <= now + 5_000 &&
		value.expiresAt > value.observedAt &&
		now < value.expiresAt
	);
}
