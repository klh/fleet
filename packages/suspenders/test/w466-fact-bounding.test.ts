// w466-fact-bounding.test.ts — W466 (openai-review reliability 1 + arch):
// the facts table is the knowledge read surface; machine cursor namespaces
// (activity.tp.*/usage.tp.*/usage.v2.tp.*) never render in `coord fact
// list` (--all lifts), --prefix/--limit bound the dump, `coord gc` migrates
// stray cursor rows into machine_cursors, and the govdb v12 migration moves
// pre-v12 cursor rows once. Never the live hub — temp HOME subprocesses.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w466-"));
const REAL_HOME = process.env.HOME;
const REG = join(HOME, ".cache/claude-governor");
const GOVDB = join(REG, "governor.db");
const BIN = join(import.meta.dir, "../hooks/bin");

const coord = (args: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(["bun", join(BIN, "coord.ts"), ...args], {
		env: { ...process.env, HOME, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode ?? 0, out: p.stdout.toString() };
};

const raw = (sql: string, ...params: (string | number)[]): void => {
	const db = new Database(GOVDB);
	db.run(sql, params);
	db.close();
};

const rawRows = (sql: string): Record<string, unknown>[] => {
	const db = new Database(GOVDB, { readonly: true });
	const rows = db.query(sql).all() as Record<string, unknown>[];
	db.close();
	return rows;
};

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("W466 fact list bounding", () => {
	test("knowledge facts render; machine cursor namespaces stay hidden", () => {
		mkdirSync(REG, { recursive: true });
		expect(coord(["fact", "set", "lesson.w466", "bounded"]).code).toBe(0);
		raw(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, strftime('%s','now')*1000)",
			"activity.tp.aaaa",
			'{"o":1,"m":2}',
		);
		raw(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, strftime('%s','now')*1000)",
			"usage.tp.bbbb",
			'{"o":3,"m":4}',
		);
		const listed = coord(["fact", "list"]).out;
		expect(listed).toContain("lesson.w466 = bounded");
		expect(listed).not.toContain("activity.tp.aaaa");
		expect(listed).not.toContain("usage.tp.bbbb");
		// --all lifts the hiding; --prefix filters; --limit caps
		expect(coord(["fact", "list", "--all"]).out).toContain("activity.tp.aaaa");
		const prefixed = coord(["fact", "list", "--prefix", "usage.tp."]).out;
		expect(prefixed).toContain("usage.tp.bbbb");
		expect(prefixed).not.toContain("lesson.w466");
		expect(coord(["fact", "list", "--limit", "1"]).out.split("\n")).toHaveLength(
			2, // one fact + trailing newline
		);
	});

	test("coord gc migrates stray cursor rows into machine_cursors", () => {
		expect(coord(["gc", "--days", "30"]).code).toBe(0);
		const facts = rawRows(
			"SELECT key FROM facts WHERE key LIKE 'activity.tp.%' OR key LIKE 'usage.tp.%'",
		);
		expect(facts).toEqual([]);
		const moved = rawRows(
			"SELECT key, value FROM machine_cursors ORDER BY key",
		) as { key: string; value: string }[];
		expect(moved.map((r) => r.key).sort()).toEqual([
			"activity.tp.aaaa",
			"usage.tp.bbbb",
		]);
		expect(moved[0].value).toBe('{"o":1,"m":2}');
	});
});

describe("W466 govdb v12 migration", () => {
	test("pre-v12 cursor rows in facts move to machine_cursors on open", () => {
		const pre = mkdtempSync(join(tmpdir(), "suspenders-w466-v12-"));
		try {
			const reg = join(pre, ".cache/claude-governor");
			mkdirSync(reg, { recursive: true });
			const db = new Database(join(reg, "governor.db"), { create: true });
			db.run("CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)");
			db.run("INSERT INTO facts VALUES ('activity.tp.cccc', '{\"o\":9,\"m\":8}', 'old-harvest', 1, 1)");
			db.run("INSERT INTO facts VALUES ('lesson.keep', 'real knowledge', 'old', 1, 1)");
			db.run("PRAGMA user_version = 11");
			db.close();
			// fresh module import under the pre-v12 HOME → openGovernorDb runs v12
			const probe = Bun.spawnSync(
				[
					"bun",
					"-e",
					`const { openGovernorDb } = await import(process.argv[1]);
					const db = openGovernorDb();
					console.log(JSON.stringify({
						v: db.query("PRAGMA user_version").get().user_version,
						moved: db.query("SELECT key FROM machine_cursors").all().map((r) => r.key),
						left: db.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'activity.tp.%'").get().n,
					}));`,
					join(import.meta.dir, "../hooks/lib/govdb.ts"),
				],
				{ env: { ...process.env, HOME: pre }, stdout: "pipe", stderr: "pipe" },
			);
			const out = probe.stdout.toString();
			const r = JSON.parse(out) as {
				v: number;
				moved: string[];
				left: number;
			};
			expect(r.v).toBeGreaterThanOrEqual(12);
			expect(r.moved).toEqual(["activity.tp.cccc"]);
			expect(r.left).toBe(0);
			// non-cursor knowledge rows are untouched
			const kept = new Database(join(reg, "governor.db"), {
				readonly: true,
			}).query("SELECT value FROM facts WHERE key = 'lesson.keep'").get() as {
				value: string;
			};
			expect(kept.value).toBe("real knowledge");
		} finally {
			rmSync(pre, { recursive: true, force: true });
		}
	});
});
