import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	appendFileSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { harvestUsage } from "../hooks/bin/usage-harvest.ts";
import { prepareUsageRebuild } from "../hooks/lib/usage-rebuild.ts";
import {
	activateTranscriptUsage,
	deactivateTranscriptUsage,
} from "../hooks/lib/usage-migration.ts";
import { buildUsageReport } from "../hooks/lib/usage.ts";
import { usagePage } from "../hooks/bin/usage-page-html.ts";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const NOW = Date.parse("2026-10-01T11:00:00Z");
const HOUR = NOW - 3600000;
const block = (output: number, id = "message-one") =>
	JSON.stringify({
		type: "assistant",
		timestamp: "2026-10-01T10:30:00Z",
		message: {
			id,
			model: "gpt-5.2",
			usage: {
				input_tokens: 100,
				output_tokens: output,
				cache_read_input_tokens: 200,
			},
		},
	});
function fixture(wal = false) {
	const dir = mkdtempSync(join(tmpdir(), "usage-migration-"));
	dirs.push(dir);
	const path = join(dir, "source.sqlite");
	const db = new Database(path, { create: true });
	if (wal) db.run("PRAGMA journal_mode=WAL");
	dbs.push(db);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY,project TEXT,role TEXT,started_at INTEGER,hb INTEGER,state TEXT,actor TEXT,tags TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY,value TEXT,source TEXT,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE usage_rollup (hour_bucket INTEGER,actor TEXT,model TEXT,model_group TEXT,in_tok INTEGER,out_tok INTEGER,cache_r INTEGER,cache_c INTEGER,requests INTEGER,PRIMARY KEY(hour_bucket,actor,model))",
	);
	db.run(
		"INSERT INTO sessions VALUES ('session','project','worker',0,0,'CLOSED','alice',NULL)",
	);
	db.query(
		"INSERT INTO usage_rollup VALUES (?,'external','other','other',999,1,0,0,7)",
	).run(HOUR);
	const root = join(dir, "transcripts");
	mkdirSync(root);
	const transcript = join(root, "session.jsonl");
	writeFileSync(transcript, `${block(5)}\n${block(5)}\n`);
	const manifest = prepareUsageRebuild(path, root, join(dir, "report"));
	return {
		db,
		root,
		transcript,
		manifest,
		path: join(dir, "report/manifest.json"),
	};
}

test("cached legacy harvester cannot consume verified deltas after activation", async () => {
	const f = fixture();
	const previous = Bun.spawnSync(
		["git", "show", "63ea547^:packages/suspenders/hooks/bin/usage-harvest.ts"],
		{
			cwd: resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(previous.exitCode, previous.stderr.toString()).toBe(0);
	const source = previous.stdout
		.toString()
		.replace(
			/from "(\.\.?\/[^"\n]+)"/g,
			(_match, relative) =>
				`from ${JSON.stringify(resolve(import.meta.dir, "../hooks/bin", relative))}`,
		);
	const cachedModule = join(dirname(f.root), "cached-legacy.ts");
	writeFileSync(cachedModule, source);
	const oldHarvest = (await import(cachedModule))
		.harvestUsage as typeof harvestUsage;
	oldHarvest(f.db, { root: f.root });
	// Include the old producer's cursor/ledger in the reviewed snapshot.
	prepareUsageRebuild(
		join(dirname(f.root), "source.sqlite"),
		f.root,
		join(dirname(f.root), "fresh-report"),
	);
	activateTranscriptUsage(
		f.db,
		join(dirname(f.root), "fresh-report/manifest.json"),
		{ reviewedSourceSelection: true },
	);
	appendFileSync(f.transcript, `${block(12)}\n`);
	expect(oldHarvest(f.db, { root: f.root }).outTok).toBe(7);
	expect(harvestUsage(f.db, { root: f.root }).outTok).toBe(7);
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.o).toBe(12);
	appendFileSync(f.transcript, `${block(19)}\n`);
	expect(harvestUsage(f.db, { root: f.root }).outTok).toBe(7);
	expect(oldHarvest(f.db, { root: f.root }).outTok).toBe(7);
	expect(harvestUsage(f.db, { root: f.root }).outTok).toBe(0);
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.o).toBe(19);
});

test("WAL source snapshot is normalized privately and hashes remain usable", () => {
	const f = fixture(true);
	activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true });
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.rq).toBe(1);
	expect(f.db.query("PRAGMA journal_mode").get()).toEqual({
		journal_mode: "wal",
	});
});

test("migration preserves legacy, verified report excludes mixed external totals, catchup is monotone", () => {
	const f = fixture();
	activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true });
	expect(f.db.query("SELECT * FROM usage_rollup").all()).toEqual(
		f.db.query("SELECT * FROM usage_rollup_legacy_archive").all(),
	);
	expect(() => f.db.run("DELETE FROM usage_rollup_legacy_archive")).toThrow(
		"immutable",
	);
	let report = buildUsageReport(f.db, { nowMs: NOW });
	expect(report.totals).toMatchObject({ i: 100, o: 5, cr: 200, rq: 1 });
	expect(report.provenance).toMatchObject({
		source: "transcript-v2",
		legacy: { i: 999, rq: 7 },
	});
	expect(usagePage(report)).toContain("Verified transcript usage");
	appendFileSync(f.transcript, `${block(12)}\n`);
	expect(harvestUsage(f.db, { root: f.root })).toMatchObject({
		requests: 0,
		outTok: 7,
		inTok: 0,
	});
	report = buildUsageReport(f.db, { nowMs: NOW });
	expect(report.totals.rq).toBe(1);
	expect(report.totals.o).toBe(12);
	activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true });
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.o).toBe(12);
	deactivateTranscriptUsage(f.db);
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.i).toBe(999);
	expect(() => harvestUsage(f.db, { root: f.root })).toThrow("metering paused");
	activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true });
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.o).toBe(12);
});

test("invalid backup and changed report are rejected without migration writes", () => {
	const f = fixture();
	expect(() => activateTranscriptUsage(f.db, f.path)).toThrow(
		"explicit reviewed",
	);
	writeFileSync(f.manifest.backup, "corrupt backup");
	expect(() =>
		activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true }),
	).toThrow("backup hash mismatch");
	expect(
		f.db
			.query(
				"SELECT name FROM sqlite_master WHERE name='usage_migration_state'",
			)
			.get(),
	).toBeNull();
	expect(f.db.query("SELECT in_tok FROM usage_rollup").get()).toEqual({
		in_tok: 999,
	});
});

test("stale legacy snapshot refuses migration rather than erase new external records", () => {
	const f = fixture();
	f.db.run("UPDATE usage_rollup SET in_tok=1000");
	expect(() =>
		activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true }),
	).toThrow("stale legacy");
	expect(f.db.query("SELECT in_tok FROM usage_rollup").get()).toEqual({
		in_tok: 1000,
	});
});

test("interrupted cursor import rolls back archive, ledger and state together", () => {
	const f = fixture();
	f.db.run(
		"CREATE TRIGGER fail_cursor BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END",
	);
	expect(() =>
		activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true }),
	).toThrow("injected cursor failure");
	expect(
		f.db
			.query(
				"SELECT name FROM sqlite_master WHERE name IN ('usage_migration_state','usage_rollup_legacy_archive','usage_verified_rollup','usage_message_ledger','usage_verified_message_ledger')",
			)
			.all(),
	).toEqual([]);
	f.db.run("DROP TRIGGER fail_cursor");
	activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true });
	expect(buildUsageReport(f.db, { nowMs: NOW }).totals.rq).toBe(1);
});

test("report tampering rejects before writing and unmigrated page identifies legacy", () => {
	const f = fixture();
	const changed = new Database(f.manifest.report);
	changed.run("UPDATE usage_rollup SET in_tok=888");
	changed.close();
	expect(() =>
		activateTranscriptUsage(f.db, f.path, { reviewedSourceSelection: true }),
	).toThrow("report hash mismatch");
	expect(usagePage(buildUsageReport(f.db, { nowMs: NOW }))).toContain(
		"Legacy aggregate usage",
	);
	expect(readFileSync(f.manifest.backup).length).toBeGreaterThan(0);
});
