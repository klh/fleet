// hooks/lib/work/work-transcript.ts — W2956: the per-lane transcript audit
// core. Two lanes claiming one work item after a stall read as duplicated LLM
// work only if their claim windows and spend are queryable together — the
// W635/W776 attribution join (claimWindows ⋈ laneSpendRows) re-reduced at
// PER-LANE grain: each lane rolls up the ledger rows it spent inside its own
// union of claim windows on the item, and time-intersecting windows of two
// DIFFERENT lanes surface as the dual-work segments the review-dedup guard
// reacts to. Pure functions on already-replayed rows; no store access here.
import type { LaneSpendRow } from "../lanes/lane-spend.ts";
import type { ClaimWindow } from "./work-timing.ts";

/** One lane's audited footprint on one item: its claim windows plus the
 *  ledger spend that fell inside their union. Windows come from
 *  claimWindows() (open claims already run to nowMs — end is a real ts). */
export interface LaneSegment {
	sid: string;
	windows: ClaimWindow[];
	/** Σ ledger rows inside the window union: non-cache prompt tokens. */
	fresh: number;
	/** cacheR + cacheC prompt tokens. */
	cached: number;
	out: number;
	requests: number;
	/** Priced cost of the attributed rows (null = nothing priced). */
	costUsd: number | null;
	/** false = the buckle ledger was unreadable — spend is unknown, never 0. */
	reported: boolean;
}

/** One dual-work finding: two lanes' windows time-intersecting on one item. */
export interface OverlapPair {
	item: string;
	a: ClaimWindow;
	b: ClaimWindow;
	start: number;
	end: number;
}

/** Pairwise time overlaps between windows of two DIFFERENT lanes. Windows
 *  arrive in claim order (claimWindows replays chronologically); a same-lane
 *  re-claim is cycle churn (W895), never dual work. Callers pass the ONE
 *  item's window list with end normalized (open → nowMs). */
export function overlapPairs(item: string, wins: ClaimWindow[]): OverlapPair[] {
	const out: OverlapPair[] = [];
	for (let i = 0; i < wins.length; i++) {
		const a = wins[i];
		if (!a) continue;
		for (let j = i + 1; j < wins.length; j++) {
			const b = wins[j];
			if (!b || a.sid === b.sid) continue;
			if (b.start < a.end)
				out.push({
					item,
					a,
					b,
					start: Math.max(a.start, b.start),
					end: Math.min(a.end, b.end),
				});
			else break; // windows sort by start — later ones cannot reach back
		}
	}
	return out;
}

// W1132-aligned cost sum: SUM semantics — unpriced rows are skipped (the
// ledger's SUM(cost_usd) ignores NULLs), so the segment cost is null only
// when NO priced row attributed. Unknown + known stays unknown at MERGE
// time, never mid-accumulation.
const addCost = (acc: number | null, row: number | null): number | null =>
	row === null ? acc : (acc ?? 0) + row;

// One bucket overlaps a window when the bucket's HOUR INTERVAL intersects
// [start, end) — the W635 sub-hour rule, verbatim (attributeBuckets).
const bucketInWindow = (bucket: string, w: ClaimWindow): number => {
	const start = Date.parse(`${bucket}:00Z`);
	if (!Number.isFinite(start)) return 0;
	return start + 3_600_000 <= w.start || start >= w.end ? 0 : start;
};

/** Per-lane segment rollup. Each ledger row counts ONCE per lane (its bucket
 *  overlapping ANY of the lane's windows — sequential re-claims must not
 *  double-count a straddling hour). rows = null → reported:false segments
 *  with zero numeric spend (unknown ≠ measured 0). */
export function laneSegments(
	wins: ClaimWindow[],
	rows: LaneSpendRow[] | null,
): Map<string, LaneSegment> {
	const out = new Map<string, LaneSegment>();
	const seg = (sid: string): LaneSegment => {
		const s = out.get(sid);
		if (s) return s;
		const fresh: LaneSegment = {
			sid,
			windows: [],
			fresh: 0,
			cached: 0,
			out: 0,
			requests: 0,
			costUsd: null,
			reported: rows !== null,
		};
		out.set(sid, fresh);
		return fresh;
	};
	const bySid = new Map<string, ClaimWindow[]>();
	for (const w of wins) {
		const arr = bySid.get(w.sid);
		if (arr) arr.push(w);
		else bySid.set(w.sid, [w]);
	}
	const seen = new Set<LaneSpendRow>();
	for (const [sid, ws] of bySid) {
		const s = seg(sid);
		s.windows = ws;
		if (!rows) continue;
		for (const r of rows) {
			if (r.sid !== sid || seen.has(r)) continue;
			for (const w of ws)
				if (bucketInWindow(r.bucket, w)) {
					seen.add(r);
					s.fresh += r.inTok;
					s.cached += r.cacheR + r.cacheC;
					s.out += r.outTok;
					s.requests += r.requests;
					s.costUsd = addCost(s.costUsd, r.costUsd);
					break;
				}
		}
	}
	return out;
}
