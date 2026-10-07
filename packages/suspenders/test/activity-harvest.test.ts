// activity-harvest.test.ts — W243: the decant-shape meter — v11 migration,
// tool→activity classification, weekly bucketing, requestId dedup, idempotent
// re-harvest + append tail, and the report math (cost shape, shares, axis,
// searches/request normalization).
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	appendFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-activity-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const { classifyTool, weekBucket, harvestActivity, activityReport, shapeCost } =
	await import(
		`../hooks/bin/activity-harvest.ts?home=${encodeURIComponent(HOME)}`
	);
process.env.HOME = REAL_HOME;

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

// ─── v11 migration guard ────────────────────────────────────────────────────
describe("govdb v11 activity migration", () => {
	test("activity_rollup + index exist; uv >= 11", () => {
		const db = openGovernorDb();
		const names = (
			db
				.query("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
				.all() as { name: string }[]
		).map((r) => r.name);
		expect(names).toContain("activity_rollup");
		expect(names).toContain("activity_rollup_actor");
		const uv = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBeGreaterThanOrEqual(11);
		db.close();
	});
});

// ─── classification primitives ──────────────────────────────────────────────
describe("classifyTool + weekBucket", () => {
	test("shell by command shape; named tools by set; unknown → context", () => {
		expect(classifyTool("Bash", { command: "rg -n foo src/" })).toBe("context");
		expect(classifyTool("Bash", { command: "git log --oneline" })).toBe(
			"context",
		);
		expect(classifyTool("Bash", { command: "rm -rf build" })).toBe("code");
		expect(classifyTool("Bash", { command: "git commit -m x" })).toBe("code");
		expect(classifyTool("Edit", {})).toBe("code");
		expect(classifyTool("Write", {})).toBe("code");
		expect(classifyTool("TodoWrite", {})).toBe("planning");
		expect(classifyTool("AskUserQuestion", {})).toBe("communicating");
		expect(classifyTool("mcp__x__y", {})).toBe("context");
	});
	test("weekBucket lands on Monday 00:00 UTC", () => {
		const wk = weekBucket(Date.parse("2026-10-01T12:00:00Z"));
		expect(new Date(wk).toISOString()).toBe("2026-09-28T00:00:00.000Z");
		expect(weekBucket(Date.parse("2026-09-28T00:00:01Z"))).toBe(wk);
		expect(weekBucket(Date.parse("2026-10-04T23:00:00Z"))).toBe(wk);
	});
});

// ─── scratch db + fixture corpus ────────────────────────────────────────────
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT, actor TEXT, tags TEXT)";
const FACTS_DDL =
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)";
const ACTIVITY_DDL =
	"CREATE TABLE activity_rollup (week_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model_group TEXT NOT NULL, activity TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week_bucket, actor, model_group, activity))";
// W466: harvest cursors live here, not in facts (govdb v12)
const MACHINE_CURSORS_DDL =
	"CREATE TABLE machine_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL)";

const H = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const WK = weekBucket(NOW);

function freshDb(n: number): Database {
	const db = new Database(join(HOME, `scratch-${n}.db`), { create: true });
	db.run(SESSIONS_DDL);
	db.run(FACTS_DDL);
	db.run(ACTIVITY_DDL);
	db.run(MACHINE_CURSORS_DDL);
	return db;
}

const ROOT = join(HOME, "projects");
mkdirSync(join(ROOT, "proj"), { recursive: true });

const MODEL = "claude-sonnet-5";
const ISO = new Date(NOW).toISOString();

const al = (
	id: string,
	u: { i: number; o: number; cr?: number; cc?: number },
	blocks: unknown[],
	iso: string,
): string =>
	JSON.stringify({
		type: "assistant",
		timestamp: iso,
		message: {
			id,
			model: MODEL,
			usage: {
				input_tokens: u.i,
				output_tokens: u.o,
				cache_read_input_tokens: u.cr ?? 0,
				cache_creation_input_tokens: u.cc ?? 0,
			},
			content: blocks,
		},
	});

const ul = (content: unknown, iso: string): string =>
	JSON.stringify({ type: "user", timestamp: iso, message: { content } });

// ─── harvest math ───────────────────────────────────────────────────────────
describe("harvestActivity", () => {
	test("classify + dedup + attribution + searches on a fixture corpus", () => {
		const db = freshDb(1);
		db.query(
			"INSERT INTO sessions (sid, actor, started_at, hb) VALUES (?, ?, ?, ?)",
		).run("lane-a", "autow243", NOW, NOW);
		const lines: string[] = [
			ul("fix the flux capacitor", ISO),
			al(
				"msg_1",
				{ i: 0, o: 40 },
				[
					{ type: "text", text: "looking" },
					{
						type: "tool_use",
						id: "t1",
						name: "Read",
						input: { file_path: "/a.ts" },
					},
					{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } },
				],
				ISO,
			),
			ul(
				[
					{ type: "tool_result", tool_use_id: "t1", content: "A".repeat(500) },
					{ type: "tool_result", tool_use_id: "t2", content: "B".repeat(300) },
					{ type: "text", text: "C".repeat(200) },
				],
				ISO,
			),
			al(
				"msg_2",
				{ i: 1000, o: 20 },
				[
					{
						type: "tool_use",
						id: "t3",
						name: "Edit",
						input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
					},
				],
				ISO,
			),
			al(
				"msg_1",
				{ i: 0, o: 70 },
				[
					{ type: "text", text: "looking" },
					{ type: "tool_use", id: "t9", name: "Read", input: {} },
				],
				ISO,
			),
			al(
				"msg_3",
				{ i: 0, o: 10 },
				[
					{
						type: "tool_use",
						id: "t4",
						name: "AskUserQuestion",
						input: { questions: [] },
					},
				],
				ISO,
			),
		];
		writeFileSync(join(ROOT, "proj", "lane-a.jsonl"), `${lines.join("\n")}\n`);
		const stats = harvestActivity(db, { root: ROOT, nowMs: NOW + H });
		// dedup contract: 4 usage rows in, 3 distinct requestIds out
		expect(stats.requests).toBe(4);
		const rows = db
			.query(
				"SELECT activity, SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(requests) AS rq, SUM(searches) AS se FROM activity_rollup GROUP BY activity",
			)
			.all() as {
			activity: string;
			i: number;
			o: number;
			rq: number;
			se: number;
		}[];
		const byAct = Object.fromEntries(rows.map((r) => [r.activity, r]));
		expect(byAct.context.rq).toBe(3); // msg_1, msg_2, msg_3 — dup collapsed
		expect(byAct.context.se).toBe(1); // the Grep
		expect(byAct.context.i).toBe(1000); // input rides the context volume
		expect(byAct.context.o).toBe(33); // 40 × 36/43 chars, growth-only dup
		expect(byAct.code.o).toBe(20); // Edit args → code
		expect(byAct.communicating.o).toBe(64); // text + AskUserQuestion + dup growth
		expect(byAct.planning).toBeUndefined(); // zero rows are skipped
		db.close();
	});

	test("idempotent re-harvest; append reads tail only", () => {
		const db = freshDb(2);
		const root2 = join(ROOT, "idem");
		mkdirSync(root2, { recursive: true });
		const p = join(root2, "lane-b.jsonl");
		writeFileSync(
			p,
			`${ul("seed", ISO)}\n${al("msg_10", { i: 0, o: 10 }, [{ type: "text", text: "hi" }], ISO)}\n`,
		);
		const s1 = harvestActivity(db, { root: root2, nowMs: NOW + H });
		expect(s1.harvested).toBe(1);
		const s2 = harvestActivity(db, { root: root2, nowMs: NOW + H });
		expect(s2.harvested).toBe(0);
		expect(s2.skipped).toBe(1);
		appendFileSync(
			p,
			`${al("msg_11", { i: 0, o: 5 }, [{ type: "text", text: "yo" }], ISO)}\n`,
		);
		const s3 = harvestActivity(db, { root: root2, nowMs: NOW + 2 * H });
		expect(s3.harvested).toBe(1);
		const tot = db
			.query(
				"SELECT SUM(out_tok) AS o, SUM(requests) AS rq FROM activity_rollup",
			)
			.get() as { o: number; rq: number };
		expect(tot.rq).toBe(2); // msg_10 + msg_11 — no double count
		expect(tot.o).toBe(15);
		db.close();
	});
});

// ─── report math ────────────────────────────────────────────────────────────
describe("activityReport", () => {
	test("cost shape, shares, axis, searches/request normalization", () => {
		const db = freshDb(3);
		const ins = db.query(
			"INSERT INTO activity_rollup (week_bucket, actor, model_group, activity, in_tok, out_tok, cache_r, cache_c, requests, searches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		// L1: context row (cost 100·1 + 100·5 = 600); L2: code row (cost 600)
		ins.run(WK, "L1", "full", "context", 100, 100, 0, 0, 10, 7);
		ins.run(WK, "L2", "full", "code", 100, 100, 0, 0, 10, 0);
		const r = activityReport(db, { weeks: 2, nowMs: NOW });
		expect(r.pricing).toEqual({ in: 1, cacheC: 1.25, cacheR: 0.1, out: 5 });
		expect(shapeCost({ in: 100, out: 100, cr: 0, cc: 0 })).toBe(600);
		const L1 = r.actors.find((a) => a.actor === "L1");
		const L2 = r.actors.find((a) => a.actor === "L2");
		expect(L1?.contextShare).toBe(1); // 600/600
		expect(L2?.contextShare).toBe(0);
		expect(r.axis.orient.share).toBeCloseTo(0.5); // orient = context cost
		expect(L1?.searchesPerReq).toBe(0.7); // 7 searches / 10 requests
		expect(r.weekly.length).toBe(2); // zero-filled window
		expect(r.totals.cost).toBe(1200);
		db.close();
	});
});
