// W635 — claimWindows replay: shared by tokenUsage (W24) and lane-spend
// (buckle ledger attribution). In-memory events table, real replay path.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { claimWindows } from "./work-timing.ts";

const PROJ = "/repo/.git";
const T0 = 1_700_000_000_000;

function db(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT, project TEXT)",
	);
	return d;
}

function ev(
	d: Database,
	kind: string,
	work: string,
	ts: number,
	by?: string,
): void {
	d.run(
		"INSERT INTO events (ts, source, kind, payload, project) VALUES (?, 'work', ?, ?, ?)",
		[ts, kind, JSON.stringify({ work, ...(by ? { by } : {}) }), PROJ],
	);
}

describe("claimWindows", () => {
	test("claimed→done closes the window and marks done", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "autow1-sid");
		ev(d, "work.done", "W1", T0 + 5_000);
		const { windows, done } = claimWindows(d, PROJ, T0 + 9_000);
		expect(windows.get("W1")).toEqual([
			{ sid: "autow1-sid", start: T0, end: T0 + 5_000 },
		]);
		expect(done.has("W1")).toBe(true);
	});

	test("open claims run to nowMs", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "autow1-sid");
		const { windows } = claimWindows(d, PROJ, T0 + 9_000);
		expect((windows.get("W1") ?? [])[0]?.end).toBe(T0 + 9_000);
	});

	test("re-claims append windows; closing events close FIFO", () => {
		const d = db();
		ev(d, "work.claimed", "W1", T0, "t1");
		ev(d, "work.released", "W1", T0 + 1_000);
		ev(d, "work.claimed", "W1", T0 + 2_000, "t2");
		ev(d, "work.done", "W1", T0 + 3_000);
		const { windows } = claimWindows(d, PROJ, T0 + 4_000);
		expect(windows.get("W1")).toEqual([
			{ sid: "t1", start: T0, end: T0 + 1_000 },
			{ sid: "t2", start: T0 + 2_000, end: T0 + 3_000 },
		]);
	});
});
