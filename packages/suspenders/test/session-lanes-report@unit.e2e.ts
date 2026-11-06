// session-lanes-report@unit.e2e.ts — W2782: the per-session lanes table.
// Unit face: pure helpers (glyph, signature, cadence decision, render). DB
// face: sessionLaneRows scoping (own claims + parent_sid children, terminal
// exclusion) and cycleReportBlock cadence against a temp-HOME governor.db +
// scratch registry. Temp HOME set before the govdb import (W1124.11).
import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "w2782-slanes-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // govdb computes REG from HOME at module load
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const {
	CYCLE_REPORT_QUIET_DEFAULT_MS,
	cycleReportBlock,
	cycleReportDecision,
	fleetLanesRows,
	lanesSignature,
	renderLanesTable,
	sessionLaneRows,
	sessionLanesBlock,
	stateGlyphWord,
	writeCycleReportState,
	readCycleReportState,
} = await import(
	`../hooks/lib/lanes/session-lanes-report.ts?home=${encodeURIComponent(HOME)}`
);
process.env.HOME = REAL_HOME; // file-scope env restore — the suite shares this process

const REPO = mkdtempSync(join(tmpdir(), "w2782-slanes-repo-"));
const PROJECT = govdb.projectIdentity(REPO);
test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test.describe("@unit", () => {
	test("stateGlyphWord: glyph + word for every graph state", () => {
		expect(stateGlyphWord("READY")).toBe("· ready");
		expect(stateGlyphWord("CLAIMED")).toBe("◐ working");
		expect(stateGlyphWord("RUNNING")).toBe("◐ working");
		expect(stateGlyphWord("DONE")).toBe("✓ done");
		expect(stateGlyphWord("FAILED")).toBe("✗ failed");
		expect(stateGlyphWord("CANCELLED")).toBe("– cancelled");
		expect(stateGlyphWord("SUPERSEDED")).toBe("– superseded");
		expect(stateGlyphWord("WEIRD")).toBe("· weird");
	});

	test("lanesSignature covers stable fields only — age ticks do not change it", () => {
		const rows = [
			{
				sid: "lane-a",
				item: "W1",
				state: "CLAIMED",
				model: "glm",
				effort: "low",
			},
			{
				sid: "lane-b",
				item: "W2",
				state: "READY",
				model: "",
				effort: null,
			},
		];
		const sig = lanesSignature(rows as never);
		// age/lastEvent move, signature must not
		const aged = [
			{ ...rows[0], ageMs: 999_999 },
			{ ...rows[1], ageMs: 1 },
		];
		expect(lanesSignature(aged as never)).toBe(sig);
		// a state flip changes it
		const flipped = [{ ...rows[0], state: "DONE" }, rows[1]];
		expect(lanesSignature(flipped as never)).not.toBe(sig);
	});

	test("cycleReportDecision: full on delta, oneliner unchanged, full again at quiet cap", () => {
		const t0 = 1_000_000;
		const first = cycleReportDecision(null, "sig", t0);
		expect(first.render).toBe("full");
		const same = cycleReportDecision(first.state, "sig", t0 + 60_000);
		expect(same.render).toBe("oneline");
		const changed = cycleReportDecision(first.state, "sig2", t0 + 60_000);
		expect(changed.render).toBe("full");
		const quiet = cycleReportDecision(
			first.state,
			"sig",
			t0 + CYCLE_REPORT_QUIET_DEFAULT_MS + 1,
		);
		expect(quiet.render).toBe("full");
		// custom quiet window (the function takes ms; cycleReportBlock converts s)
		const tight = cycleReportDecision(
			first.state,
			"sig",
			t0 + 120_000,
			60_000, // 60s quiet cap — 120s elapsed → full
		);
		expect(tight.render).toBe("full");
		// a full render resets the quiet clock: 150s is only 30s past it
		const after = cycleReportDecision(tight.state, "sig", t0 + 150_000, 60_000);
		expect(after.render).toBe("oneline");
	});

	test("cycle-report state round-trips through .fleet", () => {
		const st = { signature: "sig", lastFullTs: 42 };
		writeCycleReportState(REPO, st);
		expect(readCycleReportState(REPO)).toEqual(st);
		rmSync(join(REPO, ".fleet", "cycle-report.json"));
	});

	test("renderLanesTable: header + dash separator + row cells", () => {
		const out = renderLanesTable([
			{
				sid: "autow1-p0123456789abcdef",
				item: "W1",
				state: "CLAIMED",
				model: "glm-5.3-flash",
				effort: "low",
				ageMs: 5 * 60_000,
				lastEvent: "work.claimed",
				lastEventAgoMs: 60_000,
				verdict: "alive",
			},
			{
				sid: "s2",
				item: "W2",
				state: "FAILED",
				model: "",
				effort: null,
				ageMs: null,
				lastEvent: null,
				lastEventAgoMs: null,
				verdict: "dead",
			},
		]);
		const lines = out.split("\n");
		expect(lines[0].trim().split(/\s{2,}/)).toEqual([
			"SID",
			"ITEM",
			"STATE",
			"MODEL",
			"EFFORT",
			"AGE",
			"LAST",
		]);
		// the dash separator row: dashes only, no header text
		expect(/^[\s-]+$/.test(lines[1])).toBe(true);
		const row1 = lines.find((l) => l.includes("W1"));
		expect(row1).toContain("◐ working");
		expect(row1).toContain("glm-5.3-flash");
		expect(row1).toContain("low");
		expect(row1).toContain("5m");
		expect(row1).toContain("work.claimed");
		const row2 = lines.find((l) => l.includes("W2"));
		expect(row2).toContain("✗ failed (dead)");
		expect(row2).toContain("—");
	});
});

test.describe("db scoping @unit", () => {
	const db = govdb.openStore();
	const now = Date.now();
	// sessions: the coordinator + two children it started (a stranger session
	// exists with NO claim — the zero-lanes case)
	db.query(
		"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('coord-1', ?, 'worker', ?, ?, 'RUNNING')",
	).run(PROJECT, now, now);
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES ('child-a', ?, 'worker', 'coord-1', ?, ?, 'RUNNING')",
	).run(PROJECT, now, now);
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES ('child-b', ?, 'worker', 'coord-1', ?, ?, 'RUNNING')",
	).run(PROJECT, now, now);
	db.query(
		"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('nolanes', ?, 'worker', ?, ?, 'RUNNING')",
	).run(PROJECT, now, now);
	// items: coordinator's own claim, two child claims, a terminal DONE child
	// claim (must not scope in)
	const ins = db.query(
		"INSERT INTO work_items (project, id, title, state, priority, owner_sid, required, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)",
	);
	ins.run(PROJECT, "W1", "own", "CLAIMED", "coord-1", now, now);
	ins.run(PROJECT, "W2", "child a", "CLAIMED", "child-a", now, now);
	ins.run(PROJECT, "W3", "child b", "RUNNING", "child-b", now, now);
	ins.run(PROJECT, "W5", "done child", "DONE", "child-a", now, now);
	// a work event for W2 so LAST EVENT renders
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'work', 'work.claimed', 'W2', ?, NULL)",
	).run(now - 1000, JSON.stringify({ work: "W2", project: PROJECT }));

	test("sessionLaneRows scopes own + started lanes, excludes terminal + strangers", () => {
		const rows = sessionLaneRows(db as never, PROJECT, "coord-1", REPO, now);
		expect(rows.map((r) => r.item)).toEqual(["W1", "W2", "W3"]);
		const w2 = rows.find((r) => r.item === "W2");
		expect(w2?.sid).toBe("child-a");
		expect(w2?.lastEvent).toBe("work.claimed");
		// no registry lanes seeded: verdict stays null (no invented verdict)
		expect(rows.every((r) => r.verdict === null)).toBe(true);
	});

	test("sessionLaneRows for a session with zero scoped lanes is empty; block renders the no-lanes line", () => {
		expect(sessionLaneRows(db as never, PROJECT, "nolanes", REPO, now)).toEqual(
			[],
		);
		const block = sessionLanesBlock(db as never, PROJECT, "nolanes", REPO, now);
		expect(block).toEqual([
			"SESSION LANES: none — no lanes riding under this session",
		]);
	});

	test("sessionLanesBlock renders header + table for scoped lanes", () => {
		const block = sessionLanesBlock(db as never, PROJECT, "coord-1", REPO, now);
		expect(block[0]).toBe("SESSION LANES (3, 3 live):");
		expect(block[1]).toContain("SID");
		expect(block[1]).toContain("W2");
	});

	test("fleetLanesRows renders one row per registry lane, joining graph state", () => {
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{ sid: "child-a", item: "W2", pid: 0, launchedAt: now - 60_000 },
				{ sid: "gone", item: "W9", pid: 0, launchedAt: now - 60_000 },
			]),
		);
		const rows = fleetLanesRows(db as never, PROJECT, REPO, now);
		expect(rows.map((r) => r.item)).toEqual(["W2", "W9"]);
		const w2 = rows.find((r) => r.item === "W2");
		expect(w2?.state).toBe("CLAIMED");
		expect(w2?.ageMs).toBe(60_000);
		const w9 = rows.find((r) => r.item === "W9");
		expect(w9?.state).toBe("UNKNOWN"); // no graph row — honest unknown
	});

	test("cycleReportBlock: full table first, one-liner unchanged, delta re-renders", () => {
		// registry seeded by the previous test (W2 + W9 rows)
		const t0 = 1_000_000_000;
		const first = cycleReportBlock(db as never, PROJECT, REPO, null, t0);
		expect(first).not.toBeNull();
		expect(first?.lines[0]).toBe("CYCLE-REPORT lanes 0/2 live:");
		expect(first?.lines[1]).toContain("SID");
		expect(first?.lines[1]).toContain("W2");
		// unchanged signature within the quiet cap → one-liner
		const again = cycleReportBlock(
			db as never,
			PROJECT,
			REPO,
			first?.state ?? { signature: "", lastFullTs: 0 },
			t0 + 60_000,
		);
		expect(again?.lines).toEqual(["CYCLE-REPORT lanes 0/2 live — unchanged"]);
		// empty registry → null (nothing to report)
		writeFileSync(join(REPO, ".fleet", "lanes.json"), "[]");
		expect(cycleReportBlock(db as never, PROJECT, REPO, null, t0)).toBeNull();
	});

	test("the temp HOME isolated the governor db from the real fleet", () => {
		expect(HOME.startsWith(tmpdir())).toBe(true);
		expect(PROJECT).toContain("w2782-slanes-repo");
	});
});
