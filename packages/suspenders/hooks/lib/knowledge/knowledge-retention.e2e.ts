// knowledge-retention.e2e.ts — W2845 co-situated proof for the knowledge
// retention watermark: terminal (retired|graveyard) rows past the window
// flip to archived; live rows and fresh terminal rows never move; the row
// keeps confidence + provenance through the prune; the window starts at
// the terminal stamp (updated_at), not the birth ts; dry-run reports
// without writing; retention 0 + the pause file disable; the config reader
// defaults on absent file and throws on a bad one; the maintenance
// registry carries the task. Spec-shape law: no TS syntax here.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchWorld } from "@klh/test-kit";
import {
	RETENTION_DEFAULT_DAYS,
	RETENTION_STATE_ARCHIVED,
	knowledgeConfPath,
	readRetentionConfig,
	retentionSweep,
} from "./knowledge-retention.ts";
import { MAINTENANCE_TASKS } from "../fleet-loop/maintenance.ts";

const DAY = 86_400_000;

// one scratch knowledge table per test — no HOME pinning, no store binding
// (retentionSweep is pure over its kb handle)
function freshKb(): Database {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, graveyard_reason TEXT, confidence_stamp TEXT, created_at INTEGER, updated_at INTEGER, version INTEGER)",
	);
	return db;
}

let seedN = 1;

function seed(
	db: Database,
	state: string,
	updatedAt: number,
	opts: { ts?: number; confidence?: number } = {},
): number {
	const ts = opts.ts ?? updatedAt;
	const r = db
		.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, graveyard_reason, confidence_stamp, created_at, updated_at, version) VALUES (?, ?, 'fact text', ?, ?, ?, ?, ?, ?, 1)",
		)
		.run(
			ts,
			`t${String(seedN++)}`,
			opts.confidence ?? 0.8,
			state,
			state === "graveyard" ? "buried in audit" : null,
			'{"setter":"test"}',
			ts,
			updatedAt,
		);
	return Number(r.lastInsertRowid);
}

test.describe("@unit knowledge retention watermark", () => {
	test("terminal rows past the window archive; live and fresh-terminal rows keep", () => {
		const db = freshKb();
		const now = Date.now();
		const oldRetired = seed(db, "retired", now - 120 * DAY);
		const oldGraveyard = seed(db, "graveyard", now - 120 * DAY);
		const freshRetired = seed(db, "retired", now - 10 * DAY);
		const live = seed(db, "active", now - 400 * DAY);
		const candidate = seed(db, "candidate", now - 400 * DAY);
		const res = retentionSweep(db, { retentionDays: 90, now, act: true });
		expect(res.archived.map((a) => a.id).sort()).toEqual(
			[oldRetired, oldGraveyard].sort(),
		);
		const state = (id: number): string =>
			(
				db.query("SELECT state FROM knowledge WHERE id = ?").get(id) as {
					state: string;
				}
			).state;
		expect(state(oldRetired)).toBe(RETENTION_STATE_ARCHIVED);
		expect(state(oldGraveyard)).toBe(RETENTION_STATE_ARCHIVED);
		// fresh terminal + live rows — never touched, however old
		expect(state(freshRetired)).toBe("retired");
		expect(state(live)).toBe("active");
		expect(state(candidate)).toBe("candidate");
		db.close();
	});

	test("the prune keeps confidence + provenance on the row (watermark, not delete)", () => {
		const db = freshKb();
		const now = Date.now();
		const id = seed(db, "graveyard", now - 200 * DAY, { confidence: 0.42 });
		retentionSweep(db, { retentionDays: 90, now, act: true });
		const row = db
			.query(
				"SELECT confidence, graveyard_reason, confidence_stamp, updated_at FROM knowledge WHERE id = ?",
			)
			.get(id) as {
			confidence: number;
			graveyard_reason: string | null;
			confidence_stamp: string | null;
			updated_at: number;
		};
		expect(row.confidence).toBe(0.42);
		expect(row.graveyard_reason).toBe("buried in audit");
		expect(row.confidence_stamp).toBe('{"setter":"test"}');
		expect(row.updated_at).toBe(now - 200 * DAY); // no timestamp rewrite
		db.close();
	});

	test("the window rides the terminal stamp (updated_at), never the birth ts", () => {
		const db = freshKb();
		const now = Date.now();
		// born 300d ago, retired 10d ago — NOT past a 90d window
		const id = seed(db, "retired", now - 10 * DAY, { ts: now - 300 * DAY });
		const res = retentionSweep(db, { retentionDays: 90, now, act: true });
		expect(res.candidates).toBe(0);
		expect(
			(
				db.query("SELECT state FROM knowledge WHERE id = ?").get(id) as {
					state: string;
				}
			).state,
		).toBe("retired");
		db.close();
	});

	test("dry-run reports the due rows without writing", () => {
		const db = freshKb();
		const now = Date.now();
		const id = seed(db, "retired", now - 120 * DAY);
		const res = retentionSweep(db, { retentionDays: 90, now });
		expect(res.candidates).toBe(1);
		expect(res.archived).toEqual([]);
		expect(
			(
				db.query("SELECT state FROM knowledge WHERE id = ?").get(id) as {
					state: string;
				}
			).state,
		).toBe("retired");
		db.close();
	});

	test("retention 0 disables; the batch bounds one pass", () => {
		const db = freshKb();
		const now = Date.now();
		seed(db, "retired", now - 400 * DAY);
		const off = retentionSweep(db, { retentionDays: 0, now, act: true });
		expect(off.candidates).toBe(0);
		expect(off.archived).toEqual([]);
		for (let i = 0; i < 3; i++) seed(db, "graveyard", now - 400 * DAY);
		const bounded = retentionSweep(db, {
			retentionDays: 90,
			now,
			act: true,
			batch: 2,
		});
		expect(bounded.archived.length).toBeLessThanOrEqual(2);
		db.close();
	});

	test("the config reader: absent file defaults, valid file applies, bad file throws loud", () => {
		const dir = join(
			(globalThis as { __W2845_TMP__?: string }).__W2845_TMP__ ??
				process.env.TMPDIR ??
				"/tmp",
			`w2845-conf-${Date.now()}`,
		);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "knowledge.json");
		const absent = readRetentionConfig(path);
		expect(absent.retention_days).toBe(RETENTION_DEFAULT_DAYS);
		writeFileSync(path, '{"retention_days": 30}');
		expect(readRetentionConfig(path).retention_days).toBe(30);
		writeFileSync(path, '{"retention_days": "forever"}');
		expect(() => readRetentionConfig(path)).toThrow(/Invalid knowledge/);
		expect(knowledgeConfPath()).toContain("knowledge.json");
	});

	test("the maintenance registry carries the knowledge-retention task", () => {
		const task = MAINTENANCE_TASKS.find(
			(t) => t.name === "knowledge-retention",
		);
		expect(task).toBeDefined();
		expect(task?.argv("/pkg", "/repo")[0]).toContain("knowledge-retention.ts");
	});

	test("the CLI runner: --act archives a past-window row; the pause file parks it", () => {
		const world = scratchWorld({ prefix: "w2845-retention-" });
		// the ghost-sweep.e2e idiom: raw bun:sqlite hand-rolled kb (W92 — no
		// govdb import from a knowledge-layer file); the runner's own open
		// heals the missing columns on top of this minimal table
		const now = Date.now();
		const kbPath = join(
			world.home,
			".cache",
			"claude-governor",
			"knowledge.db",
		);
		mkdirSync(join(kbPath, ".."), { recursive: true });
		const kb = new Database(kbPath);
		kb.run(
			"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, state TEXT NOT NULL DEFAULT 'candidate', created_at INTEGER, updated_at INTEGER, version INTEGER)",
		);
		kb.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, created_at, updated_at, version) VALUES (?, 'w2845', 'runner proof', 0.8, 'retired', ?, ?, 1)",
		).run(now - 120 * DAY, now - 120 * DAY, now - 120 * DAY);
		kb.close();
		const pkg = join(import.meta.dir, "../../../");
		const env = {
			HOME: world.home,
			GOVERNOR_STORE_URL: "local",
			SUSPENDERS_MAINTENANCE: "0",
		};
		const ran = runCli(
			"hooks/bin/knowledge-retention.ts",
			["--act", "--json"],
			{
				cwd: pkg,
				env,
			},
		);
		expect(ran.code).toBe(0);
		const report = JSON.parse(ran.out.trim().split("\n").pop() ?? "{}");
		expect(report.archived.length).toBe(1);
		runnerPausedHalf(world, pkg, env);
		world.clean();
	});
});

// pause-file half of the runner test: the marker parks the sweep (PAUSED,
// 0 candidates) and the archived row from the act pass stays put.
function runnerPausedHalf(
	world: { home: string; repo: string },
	pkg: string,
	env: Record<string, string>,
): void {
	mkdirSync(join(world.repo, ".fleet"), { recursive: true });
	writeFileSync(join(world.repo, ".fleet", "knowledge-retention-paused"), "");
	const paused = runCli(
		"hooks/bin/knowledge-retention.ts",
		["--json", "--repo", world.repo],
		{ cwd: pkg, env },
	);
	expect(JSON.parse(paused.out.trim().split("\n").pop() ?? "{}").paused).toBe(
		true,
	);
	const after = new Database(
		join(world.home, ".cache", "claude-governor", "knowledge.db"),
		{ readonly: true },
	);
	expect(
		after.query("SELECT state FROM knowledge").get() as { state: string },
	).toEqual({ state: RETENTION_STATE_ARCHIVED });
	after.close();
}
