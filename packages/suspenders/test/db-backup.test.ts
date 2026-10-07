// db-backup.test.ts — W444: knowledge.db backup parity — the knowledge store
// rides the SAME `VACUUM INTO` snapshot discipline as governor.db: consistent
// read incl. WAL (a row committed by a still-open writer IS in the snapshot),
// no mutation of the live store (no checkpoint — the live -wal is untouched),
// a single self-contained snapshot file (no -wal companion to keep paired),
// a red exit on integrity failure, and rotation on the shared generation
// slots. Real db-backup.ts subprocess against a sandbox HOME — the same shape
// sim/dr-rehearsal.ts [2] runs.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-dbbackup-"));
// NB: Bun's mkdirSync(recursive) returns the PARENT path, not the leaf —
// never use its return value as the registry dir (W444 fixture lesson).
const REGD = join(HOME, ".cache", "claude-governor");
mkdirSync(REGD, { recursive: true });
const DEST = mkdtempSync(join(tmpdir(), "suspenders-dbbackup-dest-"));
const GOV = join(REGD, "governor.db");
const KB = join(REGD, "knowledge.db");

// governor fixture — minimal tables for the sanity COUNTs
const gov = new Database(GOV);
gov.exec("CREATE TABLE work_items (id INTEGER PRIMARY KEY, title TEXT)");
gov.exec("CREATE TABLE sessions (sid TEXT PRIMARY KEY)");
gov.exec("INSERT INTO work_items (title) VALUES ('seed')");
gov.exec("INSERT INTO sessions (sid) VALUES ('s1')");

// knowledge fixture — WAL mode with a writer left OPEN: committed frames sit
// in the -wal when the backup runs (uncheckpointed), and the -shm exists so
// the backup's readonly open can attach.
const kb = new Database(KB);
kb.exec("PRAGMA journal_mode = WAL");
kb.exec(
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, fact TEXT)",
);
kb.exec("INSERT INTO knowledge (topic, fact) VALUES ('t1', 'f1')");
kb.exec("INSERT INTO knowledge (topic, fact) VALUES ('t2', 'f2')");
const walBefore = statSync(`${KB}-wal`).size;
expect(walBefore).toBeGreaterThan(0);

// ancient pre-seeds — ts=1000 (1970) falls outside every rotation slot, so
// the GFS sweep must prune both
for (const f of ["governor-1000.db", "knowledge-1000.db"])
	new Database(join(DEST, f)).close();

const p = Bun.spawnSync(
	[
		"bun",
		join(import.meta.dir, "..", "hooks", "bin", "db-backup.ts"),
		"--home",
		HOME,
		"--dest",
		DEST,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const out = p.stdout.toString() + p.stderr.toString();

const kbSnaps = () =>
	readdirSync(DEST)
		.filter((f) => /^knowledge-\d+\.db$/.test(f))
		.sort((a, b) => Number(b.slice(10, -3)) - Number(a.slice(10, -3)));

describe("db-backup knowledge parity (W444)", () => {
	test("governor + knowledge snapshots both land, both integrity ok", () => {
		if (p.exitCode !== 0) console.log("BACKUP OUT:", out);
		expect(p.exitCode).toBe(0);
		expect(out.match(/integrity ok/g)?.length).toBe(2);
		expect(kbSnaps().length).toBe(1);
	});

	test("snapshot folds WAL-only rows in — consistent read incl. WAL", () => {
		const snap = kbSnaps()[0];
		const db = new Database(join(DEST, snap), { readonly: true });
		const n = (
			db.query("SELECT COUNT(*) AS n FROM knowledge").get() as { n: number }
		).n;
		db.close();
		expect(n).toBe(2);
	});

	test("live store untouched — no checkpoint, no -wal companion", () => {
		expect(statSync(`${KB}-wal`).size).toBe(walBefore);
		expect(readdirSync(DEST).some((f) => f.endsWith(".db-wal"))).toBe(false);
	});

	test("rotation prunes ancient snapshots on the shared slots", () => {
		expect(existsSync(join(DEST, "governor-1000.db"))).toBe(false);
		expect(existsSync(join(DEST, "knowledge-1000.db"))).toBe(false);
	});

	test("no knowledge.db → graceful skip, governor still backed up", () => {
		const home2 = mkdtempSync(join(tmpdir(), "suspenders-dbbackup-nokb-"));
		const regd2 = join(home2, ".cache", "claude-governor");
		mkdirSync(regd2, { recursive: true });
		const dest2 = mkdtempSync(join(tmpdir(), "suspenders-dbbackup-d2-"));
		const g = new Database(join(regd2, "governor.db"));
		g.exec("CREATE TABLE work_items (id INTEGER PRIMARY KEY, title TEXT)");
		g.exec("CREATE TABLE sessions (sid TEXT PRIMARY KEY)");
		g.close();
		const r = Bun.spawnSync(
			[
				"bun",
				join(import.meta.dir, "..", "hooks", "bin", "db-backup.ts"),
				"--home",
				home2,
				"--dest",
				dest2,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const o = r.stdout.toString() + r.stderr.toString();
		expect(r.exitCode).toBe(0);
		expect(o).not.toContain("knowledge rows");
		expect(o).toContain("integrity ok");
	});
});

afterAll(() => {
	kb.close();
	gov.close();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(DEST, { recursive: true, force: true });
});
