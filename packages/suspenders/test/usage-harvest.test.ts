// usage-harvest.test.ts — W127: usage_rollup math, idempotent re-harvest
// (same mtime+size → no double count; append → tail-only), model→group
// mapping, actor attribution via sessions.actor, and the govdb v7 migration
// (sessions.actor/tags + usage_rollup) on a temp HOME — never the live hub.
import { describe, test, expect, afterAll } from "bun:test";
import {
	runHarvestPipeline,
	type HarvestAdapter,
} from "../hooks/lib/harvest-engine.ts";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	appendFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareUsageRebuild } from "../hooks/lib/usage-rebuild.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const { harvestUsage, modelGroup, harvestAll, usageAdapter, maybeHarvest } =
	await import(
		`../hooks/lib/usage-harvest.ts?home=${encodeURIComponent(HOME)}`
	);
// restore: REG was already captured at govdb module load; leaving the temp
// HOME set leaks into later-loading suites (the gate-writes interference)
process.env.HOME = REAL_HOME;

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

// ─── v7 migration guard ─────────────────────────────────────────────────────
describe("govdb v7 usage migration", () => {
	test("sessions gains actor/tags; usage_rollup + index exist", () => {
		const db = openGovernorDb();
		const cols = (
			db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
		).map((c) => c.name);
		expect(cols).toContain("actor");
		expect(cols).toContain("tags");
		const tables = (
			db
				.query("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
				.all() as { name: string }[]
		).map((r) => r.name);
		expect(tables).toContain("usage_rollup");
		expect(tables).toContain("usage_rollup_actor");
		const uv = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBeGreaterThanOrEqual(7);
		db.close();
	});
});

// ─── model→group mapping ────────────────────────────────────────────────────
describe("modelGroup", () => {
	test("routing-doctrine classes", () => {
		expect(modelGroup("glm-5.3-flash")).toBe("flash");
		expect(modelGroup("glm-4.5-flashx")).toBe("flash"); // flash family
		expect(modelGroup("luna-local-swarm")).toBe("luna");
		expect(modelGroup("local-swarm")).toBe("local");
		expect(modelGroup("ollama/llama3:70b")).toBe("local");
		expect(modelGroup("claude-sonnet-5")).toBe("full");
		expect(modelGroup("anthropic/claude-sonnet-5")).toBe("full"); // prefix stripped
		expect(modelGroup("gpt-5.2")).toBe("full");
		expect(modelGroup("o3-mini")).toBe("full");
		expect(modelGroup("gemini-3-pro")).toBe("full");
		expect(modelGroup("<synthetic>")).toBe("other");
		expect(modelGroup("")).toBe("other");
	});
});

// ─── harvest + rollup math ──────────────────────────────────────────────────
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT, actor TEXT, tags TEXT)";
const FACTS_DDL =
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)";
const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";
// W466: harvest cursors live here, not in facts (govdb v12)
const ACT_DDL =
	"CREATE TABLE activity_rollup (week_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model_group TEXT NOT NULL, activity TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week_bucket, actor, model_group, activity))";
const MACHINE_CURSORS_DDL =
	"CREATE TABLE machine_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL)";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run(SESSIONS_DDL);
	db.run(FACTS_DDL);
	db.run(ROLLUP_DDL);
	db.run(MACHINE_CURSORS_DDL);
	db.run(ACT_DDL);
	return db;
}

function harvestFixture(db: Database, root: string) {
	// readBoardSettings resolves HOME at call time. Keep runtime settings
	// isolated as well as transcripts: the operator may configure an actor.
	const previousHome = process.env.HOME;
	process.env.HOME = HOME;
	try {
		return harvestUsage(db, { root });
	} finally {
		process.env.HOME = previousHome;
	}
}

const ROOT = join(HOME, "projects");
mkdirSync(join(ROOT, "proj"), { recursive: true });

const al = (
	model: string,
	inv: number,
	outv: number,
	iso: string,
	cacheR = 0,
	cacheC = 0,
): string =>
	JSON.stringify({
		type: "assistant",
		timestamp: iso,
		message: {
			model,
			usage: {
				input_tokens: inv,
				output_tokens: outv,
				cache_read_input_tokens: cacheR,
				cache_creation_input_tokens: cacheC,
			},
		},
	});

const bucket = (iso: string): number =>
	Math.floor(Date.parse(iso) / 3_600_000) * 3_600_000;

const rowOf = (db: Database, model: string): Record<string, string | number> =>
	db
		.query(
			"SELECT actor, model_group, in_tok, out_tok, cache_r, cache_c, requests FROM usage_rollup WHERE model = ?",
		)
		.get(model) as Record<string, string | number>;

describe("harvestUsage", () => {
	test("UTF-8 cursor resumes on byte boundary and legacy cursors fail closed", () => {
		const db = freshDb();
		const root = join(HOME, "unicode");
		mkdirSync(root, { recursive: true });
		const p = join(root, "session.jsonl");
		writeFileSync(
			p,
			`{"type":"user","text":"æ中文"}\n${al("gpt-5.2", 100, 5, "2026-10-01T10:30:00Z")}\n`,
		);
		harvestFixture(db, root);
		appendFileSync(p, `${al("gpt-5.2", 20, 2, "2026-10-01T10:31:00Z")}\n`);
		expect(harvestFixture(db, root).requests).toBe(1);
		expect(rowOf(db, "gpt-5.2")).toMatchObject({ requests: 2, in_tok: 120 });
		// a cursor without the v2 provenance marker fails closed (W466: the
		// cursor row lives in machine_cursors, not facts)
		db.run(
			"UPDATE machine_cursors SET value=json_remove(value,'$.v') WHERE key LIKE 'usage.tp.%'",
		);
		expect(() => harvestFixture(db, root)).toThrow(
			"reviewed provenance rebuild",
		);
		db.close();
	});

	test("offline rebuild snapshots source and keeps unrelated aggregates untouched", () => {
		const db = freshDb();
		db.run(
			"INSERT INTO usage_rollup VALUES (0,'external','other','other',99,1,0,0,1)",
		);
		const root = join(HOME, "rebuild-transcripts");
		mkdirSync(root, { recursive: true });
		const row = JSON.parse(al("gpt-5.2", 100, 5, "2026-10-01T10:30:00Z"));
		row.message.id = "rebuild-message";
		writeFileSync(
			join(root, "session.jsonl"),
			`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`,
		);
		const path = join(HOME, "source.sqlite");
		writeFileSync(path, db.serialize());
		db.close();
		const manifest = prepareUsageRebuild(
			path,
			root,
			join(HOME, "rebuild-output"),
		);
		expect(manifest.automaticApplyAllowed).toBe(false);
		const source = new Database(path, { readonly: true });
		expect(
			source
				.query("SELECT in_tok FROM usage_rollup WHERE actor='external'")
				.get(),
		).toEqual({ in_tok: 99 });
		source.close();
		const rebuilt = new Database(manifest.report, { readonly: true });
		expect(rowOf(rebuilt, "gpt-5.2")).toMatchObject({
			requests: 1,
			in_tok: 100,
		});
		rebuilt.close();
	});
	test("one request per message, growing blocks add only token deltas", () => {
		const db = freshDb();
		const root = join(HOME, "blocks");
		mkdirSync(root, { recursive: true });
		const p = join(root, "session.jsonl");
		const block = (out: number) => {
			const row = JSON.parse(
				al("gpt-5.2", 100, out, "2026-10-01T10:30:00Z", 200),
			);
			row.message.id = "msg-one";
			return JSON.stringify(row);
		};
		writeFileSync(p, `${block(5)}\n${block(5)}\n${block(8)}\n`);
		expect(harvestFixture(db, root).requests).toBe(1);
		expect(rowOf(db, "gpt-5.2")).toMatchObject({
			in_tok: 100,
			out_tok: 8,
			cache_r: 200,
			requests: 1,
		});
		appendFileSync(p, `${block(12)}\n`);
		const update = harvestFixture(db, root);
		expect(update.requests).toBe(0);
		expect(update.outTok).toBe(4);
		// Replay after truncation/restart still refers to the same request.
		writeFileSync(p, `${block(12)}\n`);
		expect(harvestFixture(db, root).requests).toBe(0);
		expect(rowOf(db, "gpt-5.2")).toMatchObject({ out_tok: 12, requests: 1 });
		db.close();
	});

	test("rollup failure rolls back ledger and transcript cursor", () => {
		const db = freshDb();
		const root = join(HOME, "rollback");
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "session.jsonl"),
			`${al("gpt-5.2", 100, 5, "2026-10-01T10:30:00Z")}\n`,
		);
		db.run(
			"CREATE TRIGGER fail_usage BEFORE INSERT ON usage_rollup BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);
		expect(() => harvestFixture(db, root)).toThrow("injected failure");
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'usage.tp.%'")
				.get(),
		).toEqual({ n: 0 });
		db.run("DROP TRIGGER fail_usage");
		expect(harvestFixture(db, root).requests).toBe(1);
		expect(rowOf(db, "gpt-5.2")).toMatchObject({ requests: 1, in_tok: 100 });
		db.close();
	});
	test("rollup math, actor attribution, idempotent re-harvest, append tail", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
		).run("sid-a", 1, 1, "alice", '{"team":"platform"}');
		const w = (name: string, lines: string[]): void => {
			writeFileSync(join(ROOT, "proj", name), `${lines.join("\n")}\n`);
		};
		w("sid-a.jsonl", [
			'{"type":"user","message":{"role":"user"}}',
			al("glm-5.3-flash", 100, 50, "2026-10-01T10:30:00Z", 200, 20),
			"not json",
			al("claude-sonnet-5", 10, 5, "2026-10-01T10:45:00Z"),
		]);
		w("sid-b.jsonl", [al("gpt-5.2", 7, 3, "2026-10-01T11:15:00Z")]);

		const s1 = harvestFixture(db, ROOT);
		expect(s1.requests).toBe(3);
		expect(s1.inTok).toBe(117);
		expect(s1.outTok).toBe(58);
		expect(s1.cacheR).toBe(200);
		expect(s1.cacheC).toBe(20);
		// hour bucketing: 10:30Z lands in the 10:00Z bucket
		const hbRow = db
			.query(
				"SELECT hour_bucket FROM usage_rollup WHERE model = 'glm-5.3-flash'",
			)
			.get() as { hour_bucket: number };
		expect(hbRow.hour_bucket).toBe(bucket("2026-10-01T10:00:00Z"));
		// per-row: actor attribution + exact rollup cells
		expect(rowOf(db, "glm-5.3-flash")).toEqual({
			actor: "alice",
			model_group: "flash",
			in_tok: 100,
			out_tok: 50,
			cache_r: 200,
			cache_c: 20,
			requests: 1,
		});
		expect(rowOf(db, "claude-sonnet-5")).toMatchObject({
			actor: "alice",
			model_group: "full",
		});
		expect(rowOf(db, "gpt-5.2")).toMatchObject({
			actor: "unassigned",
			model_group: "full",
		});

		// idempotent: unchanged transcripts → skipped, rollups untouched
		const s2 = harvestFixture(db, ROOT);
		expect(s2.skipped).toBe(2);
		expect(s2.harvested).toBe(0);
		expect(s2.requests).toBe(0);

		// append-only tail: a grown transcript counts ONLY the new line
		appendFileSync(
			join(ROOT, "proj", "sid-a.jsonl"),
			`${al("luna-pro", 4, 2, "2026-10-01T12:05:00Z")}\n`,
		);
		const s3 = harvestFixture(db, ROOT);
		expect(s3.harvested).toBe(1);
		expect(s3.requests).toBe(1);
		expect(rowOf(db, "glm-5.3-flash")).toMatchObject({ in_tok: 100 });
		expect(rowOf(db, "luna-pro")).toMatchObject({
			model_group: "luna",
			in_tok: 4,
			requests: 1,
		});
		db.close();
	});

	test("configured default actor applies only to sessions without attribution", () => {
		const db = freshDb();
		const root = join(HOME, "default-actor-project");
		const configDir = join(HOME, ".claude", "local-llm");
		const configPath = join(configDir, "suspenders-board.json");
		mkdirSync(root, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ default_actor: "platform" }));
		db.query(
			"INSERT INTO sessions (sid, started_at, hb, actor) VALUES (?, 1, 1, ?)",
		).run("explicit", "alice");
		writeFileSync(
			join(root, "explicit.jsonl"),
			`${al("claude-sonnet-5", 10, 5, "2026-10-01T10:45:00Z")}\n`,
		);
		writeFileSync(
			join(root, "unknown.jsonl"),
			`${al("gpt-5.2", 7, 3, "2026-10-01T11:15:00Z")}\n`,
		);
		try {
			expect(harvestFixture(db, root).requests).toBe(2);
			expect(rowOf(db, "claude-sonnet-5").actor).toBe("alice");
			expect(rowOf(db, "gpt-5.2").actor).toBe("platform");
		} finally {
			db.close();
			rmSync(configPath, { force: true });
		}
	});
});

// ─── W657 pipeline: one read pass serves both collectors ────────────────────
describe("W657 pipeline", () => {
	const PROOT = join(HOME, "pipe-root");
	test("one pass, both rollups, per-slot cursors (byte-true)", () => {
		const db = freshDb();
		mkdirSync(join(PROOT, "p1"), { recursive: true });
		const p = join(PROOT, "p1", "s.jsonl");
		writeFileSync(p, `${al("gpt-5.2", 100, 5, "2026-10-01T10:30:00Z")}\n`);
		const r = harvestAll(db, { root: PROOT });
		expect(r.usage.requests).toBe(1);
		expect(r.usage.files).toBe(1);
		expect(r.activity.harvested).toBe(1);
		expect(r.activity.files).toBe(1);
		expect(
			db.query("SELECT requests, in_tok FROM usage_rollup").get(),
		).toMatchObject({ requests: 1, in_tok: 100 });
		// per-slot cursors: two namespaces, one read, same byte offset
		const cursors = db
			.query(
				"SELECT value FROM machine_cursors WHERE key LIKE 'usage.tp.%' OR key LIKE 'activity.tp.%'",
			)
			.all() as { value: string }[];
		expect(cursors.length).toBe(2);
		const offs = cursors.map((c) => JSON.parse(c.value).o as number);
		expect(new Set(offs).size).toBe(1);
		expect(offs[0]).toBe(statSync(p).size);
		db.close();
	});

	test("flush failure rolls the whole pass back", () => {
		const db = freshDb();
		mkdirSync(join(PROOT, "p2"), { recursive: true });
		const p = join(PROOT, "p2", "s2.jsonl");
		writeFileSync(p, `${al("gpt-5.2", 10, 2, "2026-10-01T11:00:00Z")}\n`);
		const boom: HarvestAdapter = {
			name: "boom",
			prefixes: ["w657boom.tp"],
			onScan: () => {},
			flush() {
				throw new Error("boom");
			},
		};
		expect(() =>
			runHarvestPipeline(db, [usageAdapter(db), boom], { root: PROOT }),
		).toThrow("boom");
		// atomicity: usage cursor save + rollup upsert rolled back with it
		expect(db.query("SELECT value FROM machine_cursors").all().length).toBe(0);
		expect(
			db.query("SELECT COUNT(*) AS n FROM usage_rollup").get(),
		).toMatchObject({ n: 0 });
		db.close();
	});

	test("maybeHarvest gates on the shared TTL face", () => {
		const db = freshDb();
		// maybeHarvest scans the DEFAULT root ($HOME/.claude/projects) — the
		// fixture HOME is the transcript tree for this one
		mkdirSync(join(HOME, ".claude", "projects", "p3"), { recursive: true });
		const p = join(HOME, ".claude", "projects", "p3", "s.jsonl");
		writeFileSync(p, `${al("gpt-5.2", 5, 1, "2026-10-01T12:00:00Z")}\n`);
		let first: ReturnType<typeof maybeHarvest> = null;
		process.env.HOME = HOME;
		try {
			first = maybeHarvest(db, 60_000);
			// re-entrant fold: the second call inside the TTL is gated out
			expect(maybeHarvest(db, 60_000)).toBeNull();
		} finally {
			process.env.HOME = REAL_HOME;
		}
		expect(first).not.toBeNull();
		expect(first?.requests).toBe(1);
		db.close();
	});
});
