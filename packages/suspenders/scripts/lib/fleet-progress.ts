export type WorkStats = {
	counts: Record<string, number>;
	latest_done: number | null;
};
export type ProgressState = {
	progressAt?: number;
	done?: number;
	pending?: number;
	progressRestarts?: number;
	restartAt?: number;
};

/** Dispatch/log chatter is deliberately absent from the progress contract. */
export function fleetProgress(
	stats: WorkStats,
	live: number,
	previous: ProgressState,
	now: number,
	timeout = 30 * 60_000,
) {
	const pending =
		(stats.counts.READY ?? 0) +
		(stats.counts.CLAIMED ?? 0) +
		(stats.counts.RUNNING ?? 0);
	const done = stats.counts.DONE ?? 0;
	const advanced = previous.done !== undefined && done > previous.done;
	const progressAt =
		advanced || pending === 0 || previous.pending === 0
			? now
			: (previous.progressAt ?? now);
	const progressRestarts =
		advanced || pending === 0 ? 0 : (previous.progressRestarts ?? 0);
	const stalled = pending > 0 && live === 0 && now - progressAt >= timeout;
	const restart =
		stalled &&
		progressRestarts < 2 &&
		now - (previous.restartAt ?? 0) >= timeout;
	return {
		pending,
		live,
		stalled,
		restart,
		advanced,
		state: { ...previous, pending, done, progressAt, progressRestarts },
	};
}
