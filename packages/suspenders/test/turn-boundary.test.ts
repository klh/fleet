// test/turn-boundary.test.ts — W516: the stop-gate turn-boundary message
// queue (amp M3 lift, research-ampcode.md §M3). pendingTurnMessages reads
// queued operator NOTEs past the lane's inbox cursor; turnBoundaryFeedback
// renders the drain instruction; turnBoundarySid resolves lane identity via
// the shared resolveLaneContext. In-memory bus — never the live governor.db.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	pendingTurnMessages,
	turnBoundaryFeedback,
	turnBoundarySid,
} from "../hooks/lib/turn-boundary.ts";

// scratch bus: events + cursors are the only tables the queue reads
const db = new Database(":memory:");
db.run(
	"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
);
db.run("CREATE TABLE cursors (sid TEXT PRIMARY KEY, event_id INTEGER)");
const note = (id: number, source: string, text: string, target: string): void =>
	db.run(
		"INSERT INTO events (id, ts, source, kind, payload, target) VALUES (?, ?, ?, 'NOTE', ?, ?)",
		[id, Date.now(), source, JSON.stringify({ note: text }), target],
	);
const ack = (sid: string, eventId: number): void =>
	db.run(
		"INSERT INTO cursors (sid, event_id) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET event_id = excluded.event_id",
		[sid, eventId],
	);

afterAll(() => {
	db.close();
});

describe("pendingTurnMessages (W516 queue semantics)", () => {
	test("drains each lane's own NOTEs oldest-first; acked ones never re-drain", () => {
		note(1, "owner-session", "focus the gate first", "laneA");
		note(2, "board", "stop after this file", "laneA");
		note(3, "owner-session", "different lane", "laneB");
		expect(pendingTurnMessages(db, "laneA").map((m) => m.id)).toEqual([1, 2]);
		expect(pendingTurnMessages(db, "laneB").map((m) => m.id)).toEqual([3]);
		expect(pendingTurnMessages(db, "laneC")).toEqual([]);
		ack("laneA", 2);
		expect(pendingTurnMessages(db, "laneA")).toEqual([]);
	});

	test("non-JSON payloads drain as empty notes, not crashes", () => {
		db.run(
			"INSERT INTO events (id, ts, source, kind, payload, target) VALUES (?, ?, ?, 'NOTE', ?, ?)",
			[4, Date.now(), "old-writer", "{broken", "laneD"],
		);
		const msgs = pendingTurnMessages(db, "laneD");
		expect(msgs).toEqual([{ id: 4, source: "old-writer", note: "" }]);
	});
});

describe("turnBoundaryFeedback (the drain instruction)", () => {
	test("null on empty queue; lists notes + the ack step when queued", () => {
		expect(turnBoundaryFeedback([], "laneA")).toBeNull();
		const f = turnBoundaryFeedback(
			[{ id: 7, source: "owner-session-x", note: "check the diff again" }],
			"laneA",
		);
		expect(f).toContain("TURN-BOUNDARY INBOX (1)");
		expect(f).toContain("#7");
		expect(f).toContain("check the diff again");
		expect(f).toContain("coord inbox --as laneA --ack");
	});

	test("more than five messages collapses the tail", () => {
		const msgs = Array.from({ length: 7 }, (_, i) => ({
			id: i + 1,
			source: "s",
			note: `m${i + 1}`,
		}));
		const f = turnBoundaryFeedback(msgs, "laneA");
		expect(f).toContain("TURN-BOUNDARY INBOX (7)");
		expect(f).toContain("and 2 more");
		expect(f).toContain("m7");
		expect(f).not.toContain("m1");
	});
});

describe("turnBoundarySid (lane identity via resolveLaneContext)", () => {
	const REPO = mkdtempSync(join(process.cwd(), ".tmp-w516-sid-repo-"));
	afterAll(() => rmSync(REPO, { recursive: true, force: true }));
	const g = (args: string[]): void => {
		const p = spawnSync("/usr/bin/git", args, {
			cwd: REPO,
			encoding: "utf8",
		});
		if (p.status !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
	};
	g(["init", "-b", "main"]);

	test("resolves the sid from .fleet/lane-context.json", () => {
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(REPO, ".fleet", "lane-context.json"),
			JSON.stringify({ sid: "autow516x", item: "W516" }),
		);
		expect(turnBoundarySid({ cwd: REPO })).toBe("autow516x");
	});

	test("non-repo cwd has no lane identity", () => {
		expect(turnBoundarySid({ cwd: tmpdir() })).toBeNull();
	});
});
