// ghost-sweep.e2e.ts — W2842 co-situated proof for the ghost sweep: dead
// RUNNING sessions flip to GHOSTED only on the full evidence chain; live
// or unknown evidence keeps the row RUNNING. Also pins the board faces.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { scratchWorld } from "@klh/test-kit";
import { join } from "node:path";
import { ghostSweep } from "./ghost-sweep.ts";

test.describe("@unit ghost sweep", () => {
	test.describe.configure({ mode: "serial" });
	const world = scratchWorld({ prefix: "ghost-sweep-" });
	const db = new Database(join(world.home, "governor.db"));
	// the minimal governor surfaces ghostSweep reads — no store binding, no
	// machine-store pin (the module reg pins HOME at import; never openStore)
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', transcript_path TEXT)",
	);
	db.run(
		"CREATE TABLE claims (sid TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT, hot INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL)",
	);
	db.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'READY', owner_sid TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE decisions (event_id INTEGER PRIMARY KEY, target TEXT, state TEXT, delivery TEXT, created_at INTEGER, answer_token TEXT, answer_to TEXT)",
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	const store = db;
	let now = 0;
	test.beforeAll(() => {
		now = Date.now();
	});
	test.afterAll(() => {
		db.close();
		world.clean();
	});
	// a stale RUNNING session, hb 2h old
	const stale = (sid: string, hbAgeMs = 2 * 3_600_000): void => {
		store.run(
			"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'worker', ?, ?, 'RUNNING')",
			sid,
			world.repo,
			now - 3_600_000,
			now - hbAgeMs,
		);
	};
	test("unregistered stale session past 24h ghosts (dry-run reports the verdict); inside the 24h floor it keeps", () => {
		stale("ghost-a", 25 * 3_600_000);
		stale("ghost-b", 2 * 3_600_000);
		const rows = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		const a = rows.find((r) => r.sid === "ghost-a");
		const b = rows.find((r) => r.sid === "ghost-b");
		expect(a?.action).toBe("ghosted"); // dry-run: the report names it, no flip
		expect(b?.action).toBe("kept");
		expect(b?.why).toContain("24h floor");
	});
	test("act flips the state + emits one session.ghosted event per flip", () => {
		stale("ghost-c", 25 * 3_600_000);
		const rows = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
			act: true,
			transcripts: new Map([["ghost-c", false]]),
		});
		expect(rows.find((r) => r.sid === "ghost-c")?.action).toBe("ghosted");
		const state = store
			.query("SELECT state FROM sessions WHERE sid = ?")
			.get("ghost-c") as { state: string };
		expect(state.state).toBe("GHOSTED");
		const ev = store
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'session.ghosted' AND json_extract(payload, '$.sid') = ?",
			)
			.get("ghost-c") as { n: number };
		expect(ev.n).toBe(1);
		// idempotent: GHOSTED is terminal — the next pass re-finds nothing
		const again = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
			act: true,
		});
		expect(again.find((r) => r.sid === "ghost-c")).toBeUndefined();
	});
	test("coordinator role keeps; OPEN decision waiting keeps", () => {
		store.run("UPDATE sessions SET role = 'coordinator' WHERE sid = 'ghost-b'");
		stale("ghost-d", 25 * 3_600_000);
		store.run(
			"INSERT INTO decisions (event_id, target, state, delivery, created_at, answer_token, answer_to) VALUES (9001, 'ghost-d', 'OPEN', 'DELIVERED', ?, 'tok-d', 'ghost-d')",
			now,
		);
		const rows = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		expect(rows.find((r) => r.sid === "ghost-d")?.action).toBe("kept");
		store.run("DELETE FROM decisions WHERE event_id = 9001");
		const second = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		// decision cleared → the same session now meets the chain
		expect(second.find((r) => r.sid === "ghost-d")?.action).toBe("ghosted");
	});
	test("live claim keeps", () => {
		store.run(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, 'W1', 'held item', 'CLAIMED', 'ghost-e', ?, ?)",
			world.repo,
			now,
			now,
		);
		stale("ghost-e", 25 * 3_600_000);
		const held = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		expect(held.find((r) => r.sid === "ghost-e")?.action).toBe("kept");
		expect(held.find((r) => r.sid === "ghost-e")?.why).toContain("claim W1");
	});
	test("hot claims row keeps", () => {
		store.run(
			"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('ghost-f', ?, 'claim', 1, ?)",
			world.repo,
			now,
		);
		stale("ghost-f", 25 * 3_600_000);
		const hot = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		expect(hot.find((r) => r.sid === "ghost-f")?.action).toBe("kept");
	});
	test("batch bound: at most 25 flips reported per pass", () => {
		for (let i = 0; i < 30; i++) stale(`batch-${i}`, 25 * 3_600_000);
		const rows = ghostSweep(store, {
			registryDir: world.repo,
			now,
			registry: new Map(),
		});
		const flips = rows.filter((r) => r.action === "ghosted").length;
		expect(flips).toBeLessThanOrEqual(25);
		expect(flips).toBeGreaterThan(0);
	});
	test("board faces: GHOSTED is terminal in the lanes-view selection", async () => {
		const { selectGovernorLanes } = await import(
			"../../board-html/fleet-lane-view.ts"
		);
		const lanes = [
			{
				sid: "live-1",
				state: "RUNNING",
				project: "p",
				hbAgo: 10,
				verdict: "alive",
			},
			{
				sid: "ghost-1",
				state: "GHOSTED",
				project: "p",
				hbAgo: 4000,
				verdict: "dead",
			},
		];
		const view = selectGovernorLanes(lanes, "p");
		expect(view.current.some((s) => s.sid === "ghost-1")).toBe(false);
		expect(view.current.some((s) => s.sid === "live-1")).toBe(true);
	});
});
