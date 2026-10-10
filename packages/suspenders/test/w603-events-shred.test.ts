// w603-events-shred.test.ts — W603 (DuckDB-2.0 shredding + cursor-aware
// retention): govdb v14 promotes payload $.project/$.work to trigger-stamped
// indexed columns (EQP SCAN→SEARCH regression guard, the w451 shape), and
// coord gc prunes stale events only past EVERY live cursor. Never the live
// hub — temp HOME subprocesses (w451/w466 recipe); archiveAndPrune runs
// in-process over a raw temp db (retention.ts binds no govdb module state).
import { describe, expect, test, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w603-"));
const REAL_HOME = process.env.HOME;
const REG = join(HOME, ".cache/claude-governor");
const GOVDB = join(REG, "governor.db");
const GOVDB_TS = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
process.env.HOME = HOME; // retention.archiveDir() computes per call

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

const runIn = (code: string, home = HOME): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

const rawRows = (sql: string): Record<string, unknown>[] => {
	const db = new Database(GOVDB, { readonly: true });
	const rows = db.query(sql).all() as Record<string, unknown>[];
	db.close();
	return rows;
};

const DAY = 86_400_000;
const now = Date.now();

describe("W603 v14 — shredded project/work columns", () => {
	test("fresh open: columns + trigger + indexes exist; INSERT stamps them", () => {
		mkdirSync(REG, { recursive: true });
		const out = JSON.parse(
			runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB_TS)});
const db = openGovernorDb();
const uv = db.query("PRAGMA user_version").get().user_version;
const cols = db.query("PRAGMA table_info(events)").all().map((c) => c.name);
const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all().map((r) => r.name);
const trg = db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events'").all().map((r) => r.name);
db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603', 'work.claimed', ?)").run(Date.now(), JSON.stringify({ project: "/p", work: "W9" }));
db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603', 'note', ?)").run(Date.now(), JSON.stringify({ note: "bare" }));
const rows = db.query("SELECT kind, project, work FROM events ORDER BY id").all();
db.close();
console.log(JSON.stringify({ uv, cols, idx, trg, rows }));
`),
		) as {
			uv: number;
			cols: string[];
			idx: string[];
			trg: string[];
			rows: { kind: string; project: string | null; work: string | null }[];
		};
		expect(out.uv).toBeGreaterThanOrEqual(14);
		expect(out.cols).toContain("project");
		expect(out.cols).toContain("work");
		expect(out.idx).toContain("events_project_ts");
		expect(out.idx).toContain("events_work_id");
		expect(out.trg).toContain("events_shred_ai");
		expect(out.rows[0]).toEqual({
			kind: "work.claimed",
			project: "/p",
			work: "W9",
		});
		// payload without the hot keys shreds to NULL — the pre-shred shape
		expect(out.rows[1]).toEqual({ kind: "note", project: null, work: null });
	});

	test("pre-v14 db: one-time backfill shreds existing payload rows", () => {
		const home2 = mkdtempSync(join(tmpdir(), "suspenders-w603-prev14-"));
		const out = JSON.parse(
			runIn(
				`
const { Database } = await import("bun:sqlite");
const { mkdirSync } = await import("node:fs");
mkdirSync(${JSON.stringify(join(home2, ".cache/claude-governor"))}, { recursive: true });
const d = new Database(${JSON.stringify(join(home2, ".cache/claude-governor/governor.db"))});
d.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)");
d.run("INSERT INTO events (ts, source, kind, payload) VALUES (1, 'pre', 'old', ?)", JSON.stringify({ project: "/legacy", work: "W1" }));
d.run("INSERT INTO events (ts, source, kind, payload) VALUES (1, 'pre', 'old2', '{}')");
d.run("PRAGMA user_version = 13");
d.close();
const { openGovernorDb } = await import(${JSON.stringify(GOVDB_TS)});
const db = openGovernorDb();
console.log(JSON.stringify({
	uv: db.query("PRAGMA user_version").get().user_version,
	rows: db.query("SELECT project, work FROM events ORDER BY id").all(),
}));
db.close();
`,
				home2,
			),
		) as {
			uv: number;
			rows: { project: string | null; work: string | null }[];
		};
		expect(out.uv).toBeGreaterThanOrEqual(14);
		expect(out.rows[0]).toEqual({ project: "/legacy", work: "W1" });
		expect(out.rows[1]).toEqual({ project: null, work: null });
		rmSync(home2, { recursive: true, force: true });
	});
});
// volume for the EQP guard (plan shapes are the regression assertion, the
// w451 discipline) — lazy: must run AFTER suite A's row-order assertions
const seedForPlans = (): string =>
	runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB_TS)});
const db = openGovernorDb();
const ins = db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603', ?, ?)");
for (let i = 0; i < 200; i++)
	ins.run(Date.now() - i * 1000, "work.claimed", JSON.stringify({ project: "/plans", work: "W" + i }));
for (let i = 0; i < 50; i++)
	ins.run(Date.now() - i * 1000, "work.failed", JSON.stringify({ project: "/plans", work: "W" + i, note: "n" }));
db.close();
"seeded"
`);

describe("W603 — EXPLAIN QUERY PLAN regression guard", () => {
	test("timing replay (project + kind, ts-ordered) rides events_project_ts", () => {
		seedForPlans();
		const [plan] = JSON.parse(
			runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB_TS)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND project = '/plans' ORDER BY ts, id").all().map((r) => r.detail)));
`),
		) as string[];
		expect(plan).toMatch(/SEARCH.*events_project_ts/);
		expect(plan).not.toMatch(/^SCAN events/);
	});

	test("item-tail reads (kind + work) ride events_work_id", () => {
		const [plan] = JSON.parse(
			runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB_TS)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT payload FROM events WHERE kind = 'work.failed' AND work = 'W7' ORDER BY id DESC LIMIT 1").all().map((r) => r.detail)));
`),
		) as string[];
		expect(plan).toMatch(/SEARCH.*events_work_id/);
	});
});

describe("W603 cursor-aware retention — archiveAndPrune floor", () => {
	test("old rows past every cursor go; behind-cursor rows stay; archive holds them", async () => {
		const db = new Database(GOVDB);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-rt', 'rt.passed', '{}')",
		).run(now - 40 * DAY);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-rt', 'rt.behind', '{}')",
		).run(now - 40 * DAY);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-rt', 'rt.fresh', '{}')",
		).run(now);
		db.query(
			"INSERT INTO cursors (sid, event_id) VALUES ('w603-rt-reader', (SELECT MIN(id) FROM events WHERE kind = 'rt.passed'))",
		).run();
		const idOf = (kind: string): number =>
			(
				db.query("SELECT id FROM events WHERE kind = ?").get(kind) as {
					id: number;
				}
			).id;
		const { archiveAndPrune } = await import("../hooks/lib/retention.ts");
		const n = archiveAndPrune(db, {
			table: "events",
			tsCol: "ts",
			cut: now - 30 * DAY,
			dir: join(HOME, ".cache/claude-governor/archive"),
			floorCol: "id",
			floorVal: idOf("rt.passed"),
			cols: ["id", "ts", "source", "kind", "scope", "payload", "target"],
		});
		expect(n).toBe(1); // rt.passed only
		const kinds = new Set(
			rawRows("SELECT kind FROM events WHERE source = 'w603-rt'").map(
				(r) => r.kind,
			),
		);
		expect(kinds.has("rt.behind")).toBe(true); // old but unread
		expect(kinds.has("rt.fresh")).toBe(true); // inside the window
		const arch = join(HOME, ".cache/claude-governor/archive");
		const f = readdirSync(arch).find((x) => x.startsWith("events-"));
		const lines = readFileSync(join(arch, f as string), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(lines.some((r) => r.kind === "rt.passed")).toBe(true);
		// cleanup so the gc E2E below owns the whole cursor floor
		db.query("DELETE FROM cursors WHERE sid = 'w603-rt-reader'").run();
		db.query("DELETE FROM events WHERE source = 'w603-rt'").run();
		db.close();
	});
});

describe("W603 cursor-aware retention — coord gc end-to-end", () => {
	test("gc prunes stale events only past every live cursor; orphan cursors go first", () => {
		const db = new Database(GOVDB);
		db.query(
			"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w603-live', '/p', 'lane', ?, ?, 'RUNNING')",
		).run(now, now);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-gc', 'gc.passed', '{}')",
		).run(now - 40 * DAY);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-gc', 'gc.behind', '{}')",
		).run(now - 40 * DAY);
		db.query(
			"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w603-gc', 'gc.fresh', '{}')",
		).run(now);
		db.query(
			"INSERT INTO cursors (sid, event_id) VALUES ('w603-live', (SELECT id FROM events WHERE kind = 'gc.passed'))",
		).run();
		db.query(
			"INSERT INTO cursors (sid, event_id) VALUES ('w603-ghost', 1)",
		).run();
		db.close();
		const p = Bun.spawnSync(["bun", COORD, "gc", "--days", "30"], {
			env: { ...process.env, HOME, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0)
			throw new Error(`gc failed: ${new TextDecoder().decode(p.stderr)}`);
		const kinds = new Set(
			rawRows("SELECT kind FROM events WHERE source = 'w603-gc'").map(
				(r) => r.kind,
			),
		);
		expect(kinds.has("gc.passed")).toBe(false); // old + past every cursor
		expect(kinds.has("gc.behind")).toBe(true); // old but unread → survives
		expect(kinds.has("gc.fresh")).toBe(true); // inside the window
		const sids = rawRows("SELECT sid FROM cursors").map((r) => r.sid);
		expect(sids).toContain("w603-live"); // live reader kept
		expect(sids).not.toContain("w603-ghost"); // orphan reaped first
	});
});
