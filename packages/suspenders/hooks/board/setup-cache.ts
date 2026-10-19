// hooks/board/setup-cache.ts — W852: /api/setup rides a stale-while-revalidate
// cache so the checklist paints as data (page seed + feed) instead of re-probing
// per request. setupChecks() is a probe bundle (LLM + hub endpoints, multi-second
// worst case); the cache keeps the board's 1s poller off that path. The board
// warms it at start; the first caller after a cold boot awaits the one in-flight
// compute, later responses are instant; past the TTL a stale snapshot answers
// while the next compute runs in the background.
import { setupChecks } from "./data.ts";

const TTL_MS = 120_000;

let checks: unknown[] | null = null;
let at = 0;
let inflight: Promise<void> | null = null;

async function compute(): Promise<void> {
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			checks = await setupChecks();
			at = Date.now();
		} catch {
			// setupChecks is contractually never-throw; a probe bundle blowing up
			// anyway must not wedge the feed — keep the last good snapshot.
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** Kick the first compute without awaiting (board start). */
export function warmSetupCache(): void {
	if (checks !== null) return;
	void compute();
}

/** Cached checklist — instant when warm, one awaited compute after a cold
 *  boot, background refresh past the TTL. `ts` pins the snapshot so clients
 *  can tell cached from recomputed. */
export async function setupFeed(): Promise<{
	checks: unknown[];
	ts: number;
}> {
	if (checks === null) await compute();
	else if (Date.now() - at > TTL_MS) void compute();
	return { checks: checks ?? [], ts: at };
}
