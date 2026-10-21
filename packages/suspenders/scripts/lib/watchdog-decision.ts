/** Throttle repeated cards within one incident, but never mute failed delivery. */
export const deliverWatchdogDecision = (
	deliveredAt: Record<string, number>,
	key: string,
	note: string,
	now: number,
	ttlMs: number,
	deliver: (note: string) => boolean,
): boolean => {
	const last = deliveredAt[key];
	if (
		last !== undefined &&
		Number.isFinite(last) &&
		now >= last &&
		now - last < ttlMs
	)
		return false;
	if (!deliver(note)) return false;
	deliveredAt[key] = now;
	return true;
};

/** A verified healthy observation closes the incident and re-arms its card. */
export const recoverWatchdogDecision = (
	deliveredAt: Record<string, number>,
	key: string,
): void => {
	delete deliveredAt[key];
};
