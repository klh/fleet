// hooks/board/data-spend.ts — the W776 spend/attribution builders, moved
// verbatim from data.ts (W1238.6.5 decompose): the shared claim-replay event
// scan, per-item attribution + one-minute request series (5s memos) and the
// persisted histogram payload. data.ts imports workAttribution for tasks()
// and re-exports the series payload face.
import type { Database } from "bun:sqlite";
import {
	type ItemAttribution,
	type ItemSpendPoint,
	itemAttribution,
	itemRequestSpendSeries,
	type LaneRequestSpendRow,
	laneRequestSpendRows,
	resolveBuckleDb,
} from "../lib/lane-spend.ts";
import { claimWindows, type TimingEventRow } from "../lib/work-timing.ts";
import { db } from "./context.ts";

// ONE claim-replay event scan (the W635/W776/W887 attribution inputs) —
// shared by workAttribution + workSpendSeries so each memo window pays a
// single read.
function claimEventScan(): TimingEventRow[] {
	return db
		.query(
			"SELECT project, id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') ORDER BY ts, id",
		)
		.all() as TimingEventRow[];
}

// W776 — per-item attribution (spend + wall) for the tasks feed, memoized
// 5s: the /api/tasks poll storm rides the cache (W663 doctrine), one ledger
// read per TTL window. Keys are project\0id — W318 id collision.
let _wAttr: { at: number; m: Map<string, ItemAttribution> } | null = null;
const ATTR_TTL_MS = 5_000;
export function workAttribution(): Map<string, ItemAttribution> {
	if (_wAttr && Date.now() - _wAttr.at < ATTR_TTL_MS) return _wAttr.m;
	const m = new Map<string, ItemAttribution>();
	// W682: ONE claim-replay bus scan feeds every project's replay — the
	// per-project pair of events scans (25 projects × 2 = 50 store round
	// trips per TTL window) collapses into this single read.
	const evs = claimEventScan();
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		for (const [id, a] of itemAttribution(
			db as unknown as Database,
			project,
			Date.now(),
			undefined,
			evs,
		)) {
			m.set(`${project}\u0000${id}`, a);
		}
	}
	_wAttr = { at: Date.now(), m };
	return m;
}

// Per-item one-minute request series for /api/spend-series, memoized 5s like
// workAttribution. Each refresh replaces recent buckets with absolute audit
// totals. The histogram table retains older buckets across board restarts.
let _wSeries: { at: number; m: Map<string, ItemSpendPoint[]> } | null = null;
export function workSpendSeries(): Map<string, ItemSpendPoint[]> {
	if (_wSeries && Date.now() - _wSeries.at < ATTR_TTL_MS) return _wSeries.m;
	const evs = claimEventScan();
	const lastBucket = Number(
		(
			db
				.query("SELECT MAX(bucket_ms) AS t FROM work_spend_histogram")
				.get() as {
				t: number | null;
			} | null
		)?.t ?? 0,
	);
	const fromMs = Math.max(
		Date.now() - 24 * 3_600_000,
		lastBucket ? lastBucket - 2 * 3_600_000 : 0,
	);
	const fromIso = new Date(fromMs).toISOString();
	let rows: LaneRequestSpendRow[] = [];
	try {
		const ledger = resolveBuckleDb();
		rows = ledger ? laneRequestSpendRows(ledger, fromIso) : [];
	} catch {
		rows = []; // unreadable ledger — fail-soft (coord fleet parity)
	}
	const m = new Map<string, ItemSpendPoint[]>();
	const write = db.query(
		"INSERT INTO work_spend_histogram (project,work_id,bucket_ms,fresh,cached,out_tok) VALUES (?,?,?,?,?,?) ON CONFLICT(project,work_id,bucket_ms) DO UPDATE SET fresh=excluded.fresh,cached=excluded.cached,out_tok=excluded.out_tok",
	);
	const newest = db.query(
		"SELECT MAX(bucket_ms) AS t FROM work_spend_histogram WHERE project=? AND work_id=?",
	);
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		const { windows } = claimWindows(
			db as unknown as Database,
			project,
			Date.now(),
			evs,
		);
		for (const [id, points] of itemRequestSpendSeries(
			rows,
			windows,
			Number.MAX_SAFE_INTEGER,
		)) {
			const lastWritten = Number(
				(newest.get(project, id) as { t: number | null } | null)?.t ?? 0,
			);
			for (const p of points)
				if (p.t >= lastWritten - 120_000)
					write.run(project, id, p.t, p.fresh, p.cached, p.out);
		}
	}
	for (const r of db
		.query(
			"SELECT project,work_id,bucket_ms,fresh,cached,out_tok FROM work_spend_histogram ORDER BY project,work_id,bucket_ms",
		)
		.all() as {
		project: string;
		work_id: string;
		bucket_ms: number;
		fresh: number;
		cached: number;
		out_tok: number;
	}[]) {
		const key = `${r.project}\u0000${r.work_id}`;
		const points = m.get(key) ?? [];
		points.push({
			t: r.bucket_ms,
			fresh: r.fresh,
			cached: r.cached,
			out: r.out_tok,
		});
		m.set(key, points);
	}
	_wSeries = { at: Date.now(), m };
	return m;
}

/** Persisted per-item one-minute [t, fresh, cached, out] tuples, keyed project\0id. */
export function workSpendSeriesPayload(): Record<
	string,
	[number, number, number, number][]
> {
	const out: Record<string, [number, number, number, number][]> = {};
	for (const [k, points] of workSpendSeries()) {
		out[k] = points.map((p) => [p.t, p.fresh, p.cached, p.out]);
	}
	return out;
}
