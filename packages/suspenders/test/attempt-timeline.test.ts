// W1188: comparable current-attempt timelines — unit-prove the fixed-window
// contract (same window/bins on every item), the segment math, the pause
// replay with lane-state floor, and exact artifact milestone timestamps.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	ATTEMPT_BINS,
	ATTEMPT_BIN_MS,
	assembleSegments,
	attemptTimelines,
	toolSpans,
} from "../hooks/board/attempt-timeline.ts";
import { TASKS } from "../hooks/board-html/tasks.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const P = "/tmp/atw"; // events.project is a plain label in the fixture

function fixture() {
	const d = new Database(":memory:");
	d.exec(
		"CREATE TABLE facts(key TEXT,value TEXT,ts INTEGER);" +
			"CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,kind TEXT,project TEXT,work TEXT,payload TEXT,target TEXT);" +
			"CREATE TABLE work_items(project TEXT,id TEXT,created_at INTEGER)",
	);
	return d;
}

function ev(
	d: Database,
	ts: number,
	kind: string,
	project: string | null,
	work: string | null,
	payload: unknown,
	target?: string,
) {
	d.run(
		"INSERT INTO events(ts,kind,project,work,payload,target) VALUES (?,?,?,?,?,?)",
		ts,
		kind,
		project,
		work,
		typeof payload === "string" ? payload : JSON.stringify(payload),
		target ?? null,
	);
}

const MIN = 60_000;
const NOW = 1_700_003_400_000; // minute-aligned
const WS = NOW - 90 * MIN;

test("fixed window, segment math, pause floor, exact milestone timestamps", () => {
	const d = fixture();
	try {
		// Item W1: created before the window, claimed 5 min before it started,
		// first byte +12m, one tool minute +4m..+5m, pause open from +6m.
		d.run("INSERT INTO work_items VALUES (?, 'W1', ?)", P, WS - 10 * MIN);
		ev(d, WS - 5 * MIN, "work.claimed", P, "W1", { work: "W1", by: "lane-a" });
		ev(d, WS + 6 * MIN, "paused", null, null, {}, "lane-a"); // open pause, no closer
		ev(d, WS + 10 * MIN, "work.done", P, "W1", {
			work: "W1",
			commit: "cafe42",
		});
		// Item W2: born inside the window, claimed +3m, zero requests.
		d.run("INSERT INTO work_items VALUES (?, 'W2', ?)", P, WS + 1 * MIN);
		ev(d, WS + 3 * MIN, "work.claimed", P, "W2", { work: "W2", by: "lane-b" });
		const map = attemptTimelines(
			d as unknown as GovernorStore,
			[
				{
					ts: WS + 4 * MIN,
					sid: "lane-a",
					inTok: 0,
					outTok: 0,
					cacheR: 0,
					cacheC: 0,
				},
				{
					ts: WS + 12 * MIN,
					sid: "lane-a",
					inTok: 0,
					outTok: 0,
					cacheR: 0,
					cacheC: 0,
				},
			],
			NOW,
		);
		const A = map.get(`${P}\u0000W1`);
		const B = map.get(`${P}\u0000W2`);
		expect(A && B).toBeTruthy();
		expect(ATTEMPT_BINS).toBe(30);
		// Comparability: both items carry the SAME fixed window and bins.
		expect(A?.windowStart).toBe(WS);
		expect(A?.windowEnd).toBe(NOW);
		expect(A?.binMs).toBe(ATTEMPT_BIN_MS);
		expect(B?.windowStart).toBe(A?.windowStart);
		expect(B?.bins).toBe(A?.bins);
		// W1 attempt facts: index 1, claim [WS-5m, WS+10m], first byte +4m.
		expect(A?.attempt.index).toBe(1);
		expect(A?.attempt.claimStart).toBe(WS - 5 * MIN);
		expect(A?.attempt.claimEnd).toBe(WS + 10 * MIN);
		expect(A?.attempt.created).toBe(WS - 10 * MIN);
		expect(A?.attempt.firstByteAt).toBe(WS + 4 * MIN);
		// Segments: firstbyte → tool → unknown → pause (claim ends +10m).
		expect(A?.attempt.segments).toEqual([
			{ kind: "firstbyte", start: WS, end: WS + 4 * MIN },
			{ kind: "tool", start: WS + 4 * MIN, end: WS + 5 * MIN },
			{ kind: "unknown", start: WS + 5 * MIN, end: WS + 6 * MIN },
			{ kind: "pause", start: WS + 6 * MIN, end: WS + 10 * MIN },
		]);
		// The work.done artifact milestone, exact ts + commit + stage.
		expect(A?.milestones).toEqual([
			{ ts: WS + 10 * MIN, commit: "cafe42", stage: "completed" },
		]);
		// W2: unknown → queue → unknown (no requests, open claim to now).
		expect(B?.attempt.segments).toEqual([
			{ kind: "unknown", start: WS, end: WS + 1 * MIN },
			{ kind: "queue", start: WS + 1 * MIN, end: WS + 3 * MIN },
			{ kind: "unknown", start: WS + 3 * MIN, end: NOW },
		]);
		expect(B?.attempt.firstByteAt).toBeNull();
	} finally {
		d.close();
	}
});

test("toolSpans merges minute rows and clips to the claim bounds", () => {
	const t = WS + 10 * MIN;
	const rows = [
		{ ts: t, sid: "s", inTok: 0, outTok: 0, cacheR: 0, cacheC: 0 },
		{ ts: t + 30_000, sid: "s", inTok: 0, outTok: 0, cacheR: 0, cacheC: 0 },
	];
	expect(toolSpans(rows, WS, NOW)).toEqual([[t, t + MIN]]);
	expect(toolSpans(rows, t + MIN, NOW)).toEqual([]);
});

test("assembleSegments: lowest prio wins each bound, gaps stay unknown", () => {
	const segs = assembleSegments(WS, WS + 12 * MIN, [
		{ kind: "firstbyte", prio: 1, start: WS, end: WS + 4 * MIN },
		{ kind: "tool", prio: 2, start: WS + 2 * MIN, end: WS + 6 * MIN },
	]);
	expect(segs).toEqual([
		{ kind: "firstbyte", start: WS, end: WS + 4 * MIN },
		{ kind: "tool", start: WS + 4 * MIN, end: WS + 6 * MIN },
		{ kind: "unknown", start: WS + 6 * MIN, end: WS + 12 * MIN },
	]);
	expect(assembleSegments(WS, WS + MIN, [])).toEqual([
		{ kind: "unknown", start: WS, end: WS + MIN },
	]);
});

test("served task script parses and carries the attempt-view client chunk", () => {
	expect(() => new Function(TASKS)).not.toThrow();
	for (const marker of [
		"sb.attemptView",
		"kattemptwrap",
		"kattemptlabel",
		"data-attempt",
		"data-asig",
		"attemptSvg",
		"finishAttemptSvg",
		"toggleAttemptView",
	])
		expect(TASKS).toContain(marker);
	// The truthful spend chart stays: sparkline classes and axis intact.
	for (const kept of ["kspark", "spark-fresh", "spark-cached", "ksparkaxis"])
		expect(TASKS).toContain(kept);
});
