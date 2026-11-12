/**
 * Retry-safe posting: `applyPost` dedupes posts by idempotency key within
 * a replay window. A post whose key was seen within `replayWindowMs` of the
 * ORIGINAL post's timestamp is a replay and must be ignored. Older keys
 * (outside the window) are expired and the post applies fresh. The store
 * keeps at most `maxEntries` keys: when full, the OLDEST entry is evicted.
 * `nowMs` is the current time for the incoming post.
 */

export interface StoredPost {
	key: string;
	ts: number;
	result: "applied";
}

export interface PostOutcome {
	outcome: "applied" | "replayed" | "expired-replay";
	posts: StoredPost[];
}

export function applyPost(
	posts: StoredPost[],
	post: { key: string; nowMs: number },
	replayWindowMs: number,
	maxEntries: number,
): PostOutcome {
	const prior = posts.find((p) => p.key === post.key);
	if (prior) {
		const age = post.nowMs - prior.ts;
		if (age <= replayWindowMs) {
			return { outcome: "replayed", posts };
		}
	}
	const next = [
		...posts,
		{ key: post.key, ts: post.nowMs, result: "applied" as const },
	];
	while (next.length > maxEntries) next.pop();
	return { outcome: "applied", posts: next };
}
