// hooks/board/attempt-timeline.ts — W1188: comparable current-attempt lane
// timelines for /api/spend-series. The card sparkline's per-item full-history
// bins (dynamic 1/6/13-minute) made cards incomparable; this view is a ruler,
// not a history: ONE fixed common window (last 90 minutes, 3-minute bins)
// shared by every item. Segments derive only from existing facts — queue
// (created→claim via the claimWindows replay), firstbyte (claim → first
// attributed ledger request), tool spans (request minutes from the same
// rows), pause (pause/resume bus events joined by claim sid, lane-state fact
// floor for an open pause) — and every gap no fact covers stays `unknown`.
// A request row proves a request ran, nothing more; no PID/token total
// implies productivity.
import type { Database } from "bun:sqlite";
import type { GovernorStore } from "../lib/govdb.ts";
import {
	type LaneRequestSpendRow,
	laneRequestSpendRows,
	resolveBuckleDb,
} from "../lib/lane-spend.ts";
import { claimWindows, type TimingEventRow } from "../lib/work-timing.ts";
import { artifactEvidence } from "./artifact-events.ts";
import { db } from "./context.ts";

export type AttemptKind = "queue" | "firstbyte" | "tool" | "pause" | "unknown";

export interface AttemptSegment {
	kind: AttemptKind;
	start: number;
	end: number;
}

export interface AttemptMilestone {
	ts: number;
	commit: string;
	stage: string;
}

export interface AttemptTimeline {
	windowStart: number;
	windowEnd: number;
	binMs: number;
	bins: number;
	attempt: {
		sid: string;
		index: number;
		claimStart: number;
		claimEnd: number | null;
		created: number | null;
		firstByteAt: number | null;
		segments: AttemptSegment[];
	};
	milestones: AttemptMilestone[];
}

// The comparability contract: every item gets the SAME window and bins, so
// the same position on two cards means the same wall-clock minutes.
const ATTEMPT_WINDOW_MS = 90 * 60_000;
export const ATTEMPT_BIN_MS = 180_000;
export const ATTEMPT_BINS = ATTEMPT_WINDOW_MS / ATTEMPT_BIN_MS; // 30

const PAUSE_OPEN = new Set(["pause_requested", "paused"]);
const PAUSE_CLOSE = new Set(["resume_ready", "resumed"]);

/** Pause intervals per lane sid, replayed from the bus like the claim
 * windows: openers/closers pair FIFO, an unclosed opener runs to +Infinity
 * and gets clipped by the assembly sweep. The 7-day scan bound covers any
 * pause overlapping the 90-minute window without reading the whole table. */
function pauseIntervals(
	db: GovernorStore,
	sinceMs: number,
): Map<string, [number, number][]> {
	const rows = db
		.query(
			"SELECT ts, kind, target FROM events WHERE kind IN ('pause_requested','paused','resume_ready','resumed') AND ts >= ? ORDER BY ts",
		)
		.all(sinceMs - 7 * 86_400_000) as {
		ts: number;
		kind: string;
		target: string | null;
	}[];
	const open = new Map<string, number>();
	const out = new Map<string, [number, number][]>();
	const push = (sid: string, s: number, e: number) => {
		const arr = out.get(sid);
		if (arr) arr.push([s, e]);
		else out.set(sid, [[s, e]]);
	};
	for (const r of rows) {
		const sid = r.target ?? "";
		if (PAUSE_OPEN.has(r.kind)) {
			if (!open.has(sid)) open.set(sid, r.ts);
		} else if (PAUSE_CLOSE.has(r.kind)) {
			const s = open.get(sid);
			open.delete(sid);
			if (s != null) push(sid, s, r.ts);
		}
	}
	for (const [sid, s] of open) push(sid, s, Number.POSITIVE_INFINITY);
	return out;
}

/** Current lane states — the floor for a pause with no closing event: the
 * canonical fact says PAUSED, so the pause is still open. */
function laneStates(
	db: GovernorStore,
): Map<string, { value: string; ts: number }> {
	const out = new Map<string, { value: string; ts: number }>();
	for (const r of db
		.query("SELECT key, value, ts FROM facts WHERE key LIKE 'lane.%.state'")
		.all() as { key: string; value: string; ts: number }[]) {
		const sid = r.key.slice("lane.".length, -".state".length);
		out.set(sid, { value: r.value, ts: r.ts });
	}
	out.delete("");
	return out;
}

interface SegmentCandidate {
	kind: AttemptKind;
	prio: number;
	start: number;
	end: number;
}

/** Sweep [ws,we) partitioned by every candidate bound; the highest-priority
 * (lowest number) covering candidate wins each elementary interval; gaps no
 * candidate covers stay `unknown`. */
export function assembleSegments(
	ws: number,
	we: number,
	cands: SegmentCandidate[],
): AttemptSegment[] {
	const pts = new Set<number>([ws, we]);
	for (const c of cands) {
		for (const p of [c.start, c.end]) {
			if (p > ws && p < we) pts.add(p);
		}
	}
	const bounds = [...pts].sort((a, b) => a - b);
	const raw: AttemptSegment[] = [];
	for (let i = 0; i < bounds.length - 1; i++) {
		const a = bounds[i];
		const b = bounds[i + 1];
		let best: SegmentCandidate | null = null;
		for (const c of cands) {
			if (c.start <= a && c.end >= b && (!best || c.prio < best.prio)) best = c;
		}
		raw.push(
			best
				? { kind: best.kind, start: a, end: b }
				: { kind: "unknown", start: a, end: b },
		);
	}
	const merged: AttemptSegment[] = [];
	for (const s of raw) {
		const last = merged[merged.length - 1];
		if (last && last.kind === s.kind && last.end === s.start) last.end = s.end;
		else merged.push(s);
	}
	return merged;
}

/** Tool spans = per-minute spans around each request row, merged when
 * overlapping/adjacent. A minute with a request ran a request; the spans say
 * nothing about what the lane did between minutes. */
export function toolSpans(
	rows: LaneRequestSpendRow[],
	lo: number,
	hi: number,
): [number, number][] {
	const spans: [number, number][] = [];
	for (const r of rows) {
		const s = Math.floor(r.ts / 60_000) * 60_000;
		const e = s + 60_000;
		if (e <= lo || s >= hi) continue;
		const last = spans[spans.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else spans.push([s, e]);
	}
	return spans;
}

/** One timeline per item whose CURRENT attempt (the last claim window —
 * claimWindows is the W635/W776 attribution source, not a second replay)
 * overlaps the common window. Milestones are the W1184 artifact events. */
export function attemptTimelines(
	db: GovernorStore,
	requests: readonly LaneRequestSpendRow[],
	now = Date.now(),
): Map<string, AttemptTimeline> {
	const windowStart = now - ATTEMPT_WINDOW_MS;
	const out = new Map<string, AttemptTimeline>();
	const bySid = new Map<string, LaneRequestSpendRow[]>();
	for (const r of requests) {
		if (r.ts < windowStart - 120_000) continue;
		const arr = bySid.get(r.sid);
		if (arr) arr.push(r);
		else bySid.set(r.sid, [r]);
	}
	for (const arr of bySid.values()) arr.sort((a, b) => a.ts - b.ts);
	const pauses = pauseIntervals(db, windowStart);
	const states = laneStates(db);
	const artifacts = artifactEvidence(db);
	const evs = db
		.query(
			"SELECT project, id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') ORDER BY ts, id",
		)
		.all() as TimingEventRow[];
	const created = new Map<string, number>();
	for (const r of db
		.query("SELECT project, id, created_at FROM work_items")
		.all() as { project: string; id: string; created_at: number }[])
		created.set(`${r.project}\0${r.id}`, r.created_at);
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		const { windows } = claimWindows(
			db as unknown as Database,
			project,
			now,
			evs,
		);
		for (const [id, wins] of windows) {
			const cur = wins[wins.length - 1];
			if (!cur) continue;
			// The sweep ALWAYS spans the common window — pre-claim minutes stay
			// in it as queue/unknown — or the timelines would not be comparable.
			const lo = windowStart;
			const hi = Math.min(cur.end || now, now);
			if (hi <= lo) continue;
			const rows = bySid.get(cur.sid) ?? [];
			const firstByteAt = rows.length ? rows[0].ts : null;
			const pauseSpans: [number, number][] = [...(pauses.get(cur.sid) ?? [])];
			const st = states.get(cur.sid);
			if (st && PAUSE_OPEN.has(st.value))
				pauseSpans.push([st.ts, Number.POSITIVE_INFINITY]);
			const cands: SegmentCandidate[] = [];
			const createdAt = created.get(`${project}\0${id}`);
			if (createdAt != null && createdAt < cur.start)
				cands.push({
					kind: "queue",
					prio: 0,
					start: createdAt,
					end: cur.start,
				});
			if (firstByteAt != null && firstByteAt > cur.start)
				cands.push({
					kind: "firstbyte",
					prio: 1,
					start: cur.start,
					end: firstByteAt,
				});
			for (const [s, e] of toolSpans(rows, windowStart, hi))
				cands.push({ kind: "tool", prio: 2, start: s, end: e });
			for (const [s, e] of pauseSpans)
				cands.push({ kind: "pause", prio: 3, start: s, end: e });
			out.set(`${project}\0${id}`, {
				windowStart,
				windowEnd: now,
				binMs: ATTEMPT_BIN_MS,
				bins: ATTEMPT_BINS,
				attempt: {
					sid: cur.sid,
					index: wins.length,
					claimStart: cur.start,
					claimEnd: cur.end || null,
					created: createdAt ?? null,
					firstByteAt,
					segments: assembleSegments(lo, hi, cands),
				},
				milestones: artifacts
					.filter(
						(a) =>
							a.project === project &&
							a.item === id &&
							a.ts >= windowStart &&
							a.ts <= hi,
					)
					.map((a) => ({ ts: a.ts, commit: a.commit, stage: a.stage }))
					.sort((a, b) => a.ts - b.ts),
			});
		}
	}
	return out;
}

// The /api/spend-series wire face, memoized 5s like the series itself — the
// card polls ride one read per TTL window (W663 doctrine).
let _attempts: { at: number; p: Record<string, AttemptTimeline> } | null = null;
const ATTEMPT_TTL_MS = 5_000;

export function attemptTimelinesPayload(): Record<string, AttemptTimeline> {
	if (_attempts && Date.now() - _attempts.at < ATTEMPT_TTL_MS)
		return _attempts.p;
	const now = Date.now();
	let rows: LaneRequestSpendRow[] = [];
	try {
		const ledger = resolveBuckleDb();
		rows = ledger
			? laneRequestSpendRows(
					ledger,
					new Date(now - ATTEMPT_WINDOW_MS - 120_000).toISOString(),
				)
			: [];
	} catch {
		rows = []; // unreadable ledger — fail-soft (series parity)
	}
	const p: Record<string, AttemptTimeline> = {};
	for (const [k, v] of attemptTimelines(db, rows, now)) p[k] = v;
	_attempts = { at: now, p };
	return p;
}
