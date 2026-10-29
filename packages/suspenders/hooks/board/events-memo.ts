// board/events-memo.ts — memo keyed on the events bus high-water mark.
// events is append-only: an unchanged (MIN(id), MAX(id)) span — two rowid
// seeks — means every scan over it returns the same rows, so the board's
// per-poll bus scans (claim replay, artifact evidence) recompute only when
// something was appended (MAX moves) or retention pruned (MIN moves).
// The one in-place rewrite (coord project rekey) shows up on the next append.
import type { GovernorStore } from "../lib/govdb/govdb.ts";

// per store handle, so two stores (tests, federation) never share a scan
const memos = new WeakMap<
	GovernorStore,
	Map<string, { key: string; value: unknown }>
>();

export function eventsHighWater(db: GovernorStore): string {
	const hw = db
		.query("SELECT MIN(id) AS lo, MAX(id) AS hi FROM events")
		.get() as { lo: number | null; hi: number | null } | null;
	return `${hw?.lo ?? 0}:${hw?.hi ?? 0}`;
}

/** The control-plane change stamp for whole-feed memos: the bus span plus
 * the W33 delta log's head (deltas.seq — every write to sessions, claims,
 * facts, work_items… appends one via trigger), so a direct table write that
 * emits no event (a DONE flip) still invalidates — plus the work_deps row
 * count, the one feed input outside both (`work block`/`unblock`). One
 * statement, so an HTTP-bound store pays one round trip. */
export function stateHighWater(db: GovernorStore): string {
	try {
		const r = db
			.query(
				"SELECT (SELECT MIN(id) FROM events) AS lo, (SELECT MAX(id) FROM events) AS hi, (SELECT MAX(seq) FROM deltas) AS seq, (SELECT COUNT(*) FROM work_deps) AS deps",
			)
			.get() as Record<string, number | null> | null;
		return `${r?.lo ?? 0}:${r?.hi ?? 0}:${r?.seq ?? 0}:${r?.deps ?? 0}`;
	} catch {
		return eventsHighWater(db); // pre-W33 store: the bus span alone
	}
}

export function memoOnEvents<T>(
	name: string,
	db: GovernorStore,
	compute: () => T,
): T {
	const key = eventsHighWater(db);
	let memo = memos.get(db);
	if (!memo) {
		memo = new Map();
		memos.set(db, memo);
	}
	const hit = memo.get(name);
	if (hit?.key === key) return hit.value as T;
	const value = compute();
	memo.set(name, { key, value });
	return value;
}
