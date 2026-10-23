// test/work-completion-reactivation.test.ts — W1173: a retained completion
// record is completed history. The observed incident: an item was retried to
// CLAIMED while its immutable work_completion_records row stood (0daf6a49);
// the next close collided on PK(project,item) and the raw SQL error surfaced
// as an opaque store failure. Regression: the real CLI fail/retry sequence
// refuses deterministically, and a re-close is refused before the INSERT.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	persistCompletion,
	prepareCompletion,
	reactivationRefusal,
} from "../hooks/lib/work-completion-record.ts";
import { retryFailedItem } from "../hooks/lib/work-retry.ts";

const recordOf = (item: string, sha: string) => ({
	project: "p",
	item,
	summary: "x".repeat(40),
	summary_hash: "h",
	commit_sha: sha,
	baseline_sha: null,
	completed_by: "lane-a",
	completed_at: Date.now(),
	capsule_json: "{}",
	evidence_json: "}",
});

// persistCompletion's ensureRecords mints the immutable table + triggers;
// the facts upsert inside persistCompletion needs the facts table.
const seededStore = (): GovernorStore => {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	persistCompletion(db, recordOf("W1", "0daf6a49000000000000"));
	return db;
};

// retryFailedItem's fixture shape (work-retry.test.ts) + the record table
const retryFixture = (state: string): GovernorStore => {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER)",
	);
	db.run("CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT)");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER)",
	);
	db.run(`INSERT INTO work_items VALUES ('p','W1','${state}','lane','s',100)`);
	persistCompletion(db, recordOf("W1", "0daf6a49000000000000"));
	return db;
};

describe("retained-completion fences (W1173)", () => {
	test("retry of a FAILED completed item refuses deterministically (not the PK collision)", () => {
		const r = retryFailedItem(retryFixture("FAILED"), "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("immutable completion record");
		expect(r.error).toContain("@0daf6a49");
		// W1173 typed refusal: callers key on the stable code, never SQL text
		expect(r.code).toBe("WORK_COMPLETION_RECORD_EXISTS");
	});

	test("retry of a DONE completed item refuses (guard precedes state logic)", () => {
		const r = retryFailedItem(retryFixture("DONE"), "p", "W1");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("immutable completion record");
	});

	test("re-close preflight refuses before any gate or git exec", () => {
		expect(() =>
			prepareCompletion(seededStore(), {
				project: "p",
				item: "W1",
				sid: "manual",
				cwd: process.cwd(),
				sha: null,
				summary: null,
			}),
		).toThrow("immutable completion record");
	});

	test("double persistCompletion refuses at the INSERT fence (smallest failing regression)", () => {
		expect(() =>
			persistCompletion(seededStore(), recordOf("W1", "0daf6a49000000000000")),
		).toThrow("immutable completion record");
	});

	test("legacy stores without the record table see no refusal (no false positive)", () => {
		const db = new Database(":memory:") as unknown as GovernorStore;
		expect(reactivationRefusal(db, "p", "W1")).toBeNull();
	});
});

const HOME = mkdtempSync(join(tmpdir(), "w1173-cli-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w1173-cli-repo-"));
Bun.spawnSync(["git", "init", "-q", REPO]);
afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const work = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "bin", "work.ts"), ...args],
		{
			cwd: REPO,
			env: {
				...process.env,
				HOME: HOME,
				NO_COLOR: "1",
				GOVERNOR_STORE_URL: "local",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

const seed = (js: string): string => {
	const p = Bun.spawnSync(["bun", "-e", js], {
		cwd: REPO,
		env: {
			...process.env,
			HOME: HOME,
			NO_COLOR: "1",
			GOVERNOR_STORE_URL: "local",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`seed failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

const storeLib = JSON.stringify(
	join(import.meta.dir, "..", "hooks", "lib", "govdb-store.ts"),
);
const recordLib = JSON.stringify(
	join(import.meta.dir, "..", "hooks", "lib", "work-completion-record.ts"),
);

describe("real CLI fail/retry over a retained record (W1173)", () => {
	test("fail and retry refuse with the deterministic diagnostic; evidence stands", () => {
		expect(work(["add", "w1173 reactivation item", "--by", "op"]).code).toBe(0);
		seed(`const { openStore } = await import(${storeLib});
const { persistCompletion } = await import(${recordLib});
const s = openStore();
const row = s.query("SELECT project FROM work_items WHERE id='W1'").get();
await persistCompletion(s, { project: row.project, item: "W1", summary: "x".repeat(40), summary_hash: "h", commit_sha: "0daf6a49000000000000", baseline_sha: null, completed_by: "lane-a", completed_at: Date.now(), capsule_json: "{}", evidence_json: "{}" });
console.log("seeded");`);
		// capture the exact pre-attempt state: the immutable receipt and the
		// item's row (the current claim) must survive the refusals byte-identical
		const before = seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const rec = s.query("SELECT * FROM work_completion_records WHERE item='W1'").get();
const it = s.query("SELECT * FROM work_items WHERE id='W1'").get();
console.log(JSON.stringify({ rec, it }));`);
		const fail = work(["fail", "W1"]);
		expect(fail.code).not.toBe(0);
		expect(fail.err).toContain("immutable completion record");
		// the typed refusal code is the machine key (never a raw SQL string)
		expect(fail.err).toContain("WORK_COMPLETION_RECORD_EXISTS");
		const retry = work(["retry", "W1"]);
		expect(retry.code).not.toBe(0);
		expect(retry.err).toContain("immutable completion record");
		expect(retry.err).toContain("WORK_COMPLETION_RECORD_EXISTS");
		const after = seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const rec = s.query("SELECT * FROM work_completion_records WHERE item='W1'").get();
const it = s.query("SELECT * FROM work_items WHERE id='W1'").get();
console.log(JSON.stringify({ rec, it }));`);
		// claim rollback: the refused attempts advance nothing — the item row
		// and the immutable receipt are byte-identical across both refusals
		expect(JSON.parse(after)).toEqual(JSON.parse(before));
		// the immutable evidence itself must stand untouched after both refusals
		expect(
			seed(`const { openStore } = await import(${storeLib});
const s = openStore();
const row = s.query("SELECT commit_sha FROM work_completion_records WHERE item='W1'").get();
console.log(String(row.commit_sha));`),
		).toContain("0daf6a49");
	});
});
