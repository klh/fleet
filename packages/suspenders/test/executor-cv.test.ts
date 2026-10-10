// test/executor-cv.test.ts — W620: the executor trust fold — replay the
// EXISTING work bus (claimed/released/done/failed) into per-class
// consecutive-valid counters, facts executor.<host>.<model>.cv.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cvKey,
	cvMap,
	executorCv,
	recordLaneExecutor,
	writeExecutorCvFacts,
} from "../hooks/lib/executor-cv.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// shaOnMain memoizes per sha at module level — real scratch-repo commits
// keep every run's shas unique, so the memo never crosses test cases.
const git = (repo: string, ...args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};
const scratchRepo = (): { dir: string; sha: string; project: string } => {
	const d = mkdtempSync(join(tmpdir(), "w620-cv-"));
	dirs.push(d);
	Bun.spawnSync(["git", "init", "-q", "-b", "main", d]);
	writeFileSync(join(d, "f.txt"), "x\n");
	git(d, "add", ".");
	git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "a");
	return { dir: d, sha: git(d, "rev-parse", "HEAD"), project: `${d}/.git` };
};
// a parentless commit: known to git, verified NOT an ancestor of main
const orphanSha = (d: string): string => {
	const tree = git(d, "rev-parse", "HEAD^{tree}");
	return git(
		d,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit-tree",
		tree,
		"-m",
		"orphan",
	);
};

const store = (): GovernorStore => {
	const db = new Database(":memory:");
	dbs.push(db);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, payload TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER DEFAULT 1, ts INTEGER)",
	);
	db.run(
		"CREATE TABLE lane_launch_intents (project TEXT, item TEXT, sid TEXT, nonce TEXT, revision INTEGER, executor TEXT, host TEXT, attempt INTEGER, state TEXT, pid INTEGER, birth TEXT, PRIMARY KEY(project,item))",
	);
	return db as unknown as GovernorStore;
};

let tick = 0;
const ev = (
	db: GovernorStore,
	kind: string,
	payload: Record<string, unknown>,
): void => {
	db.query("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run(
		++tick,
		kind,
		JSON.stringify(payload),
	);
};
const fact = (db: GovernorStore, key: string, value: string): void => {
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 't', 1)",
	).run(key, value);
};

test("done with an on-main sha increments the claimant's class", () => {
	const db = store();
	const r = scratchRepo();
	fact(db, "lane.s1.model", "glm-x");
	ev(db, "work.claimed", { work: "W1", by: "s1", project: r.project });
	ev(db, "work.done", {
		work: "W1",
		sha: r.sha,
		project: r.project,
		verified: true,
	});
	const tally = executorCv(db, { host: "h1" });
	const t = tally.get(cvKey("h1", "glm-x"));
	expect(t?.cv).toBe(1);
	expect(t?.valid).toBe(1);
	expect(t?.invalid).toBe(0);
});

test("fail resets the counter", () => {
	const db = store();
	const r = scratchRepo();
	fact(db, "lane.s1.model", "glm-x");
	ev(db, "work.claimed", { work: "W1", by: "s1", project: r.project });
	ev(db, "work.done", { work: "W1", sha: r.sha, project: r.project });
	ev(db, "work.claimed", { work: "W2", by: "s1", project: r.project });
	ev(db, "work.failed", { work: "W2", note: "boom" });
	const t = executorCv(db, { host: "h1" }).get(cvKey("h1", "glm-x"));
	expect(t?.cv).toBe(0);
	expect(t?.invalid).toBe(1);
});

test("reclaim resets; owner-release is reassignment, not a failure", () => {
	const db = store();
	const r = scratchRepo();
	fact(db, "lane.s1.model", "glm-x");
	ev(db, "work.claimed", { work: "W1", by: "s1", project: r.project });
	ev(db, "work.done", { work: "W1", sha: r.sha, project: r.project });
	ev(db, "work.claimed", { work: "W2", by: "s1", project: r.project });
	ev(db, "work.released", {
		work: "W2",
		reason: "operator-reclaim",
		by: "op",
	});
	const t = executorCv(db, { host: "h1" }).get(cvKey("h1", "glm-x"));
	expect(t?.cv).toBe(0);
	expect(t?.invalid).toBe(1);
});

test("pending sha (known, not on main) is never a verdict", () => {
	const db = store();
	const r = scratchRepo();
	fact(db, "lane.s1.model", "glm-x");
	ev(db, "work.claimed", { work: "W1", by: "s1", project: r.project });
	ev(db, "work.done", {
		work: "W1",
		sha: orphanSha(r.dir),
		project: r.project,
	});
	const t = executorCv(db, { host: "h1" }).get(cvKey("h1", "glm-x"));
	// pending = no verdict = no row; missing reads as 0 everywhere
	expect(t?.cv ?? 0).toBe(0);
	expect(t?.valid).toBeUndefined();
});

test("unknown sha and unattributable sid contribute nothing", () => {
	const db = store();
	const r = scratchRepo();
	fact(db, "lane.s1.model", "glm-x");
	// sha git cannot resolve at all
	ev(db, "work.claimed", { work: "W1", by: "s1", project: r.project });
	ev(db, "work.done", {
		work: "W1",
		sha: "f".repeat(40),
		project: r.project,
	});
	// claimant with no facts and no intent row
	ev(db, "work.claimed", { work: "W2", by: "ghost", project: r.project });
	ev(db, "work.done", { work: "W2", sha: r.sha, project: r.project });
	const tally = executorCv(db, { host: "h1" });
	// unattributable + unverified = no row for the class at all
	expect(tally.get(cvKey("h1", "glm-x"))?.cv ?? 0).toBe(0);
	expect(tally.size).toBe(0);
});

test("intent rows fill class + host when facts are absent", () => {
	const db = store();
	const r = scratchRepo();
	db.query(
		"INSERT INTO lane_launch_intents (project, item, sid, nonce, revision, executor, host, attempt, state) VALUES ('p', 'W1', 's2', 'n', 1, 'codex', 'nas', 0, 'REGISTERED')",
	).run();
	ev(db, "work.claimed", { work: "W1", by: "s2", project: r.project });
	ev(db, "work.done", { work: "W1", sha: r.sha, project: r.project });
	const t = executorCv(db).get(cvKey("nas", "codex"));
	expect(t?.cv).toBe(1);
});

test("facts round-trip: writeExecutorCvFacts + cvMap are host-scoped", () => {
	const db = store();
	const tally = new Map([
		[cvKey("h1", "glm-x"), { cv: 5, valid: 5, invalid: 0 }],
		[cvKey("nas", "codex"), { cv: 2, valid: 2, invalid: 0 }],
	]);
	writeExecutorCvFacts(db, tally);
	const h1 = cvMap(db, "h1");
	expect(h1.get("glm-x")).toBe(5);
	expect(h1.get("codex")).toBeUndefined();
	expect(cvMap(db, "nas").get("codex")).toBe(2);
});

test("recordLaneExecutor stamps executor always, model only when pinned", () => {
	const db = store();
	recordLaneExecutor(db, "s9", "llm:desktop:glm-x", "glm-x");
	recordLaneExecutor(db, "s10", "claude", null);
	const vals = (sid: string): Map<string, string> =>
		new Map(
			(
				db.query("SELECT key, value FROM facts WHERE key LIKE ?")
					.all(`lane.${sid}.%`) as { key: string; value: string }[]
			).map((r) => [r.key, r.value]),
		);
	const m9 = vals("s9");
	expect(m9.get(`lane.s9.executor`)).toBe("llm:desktop:glm-x");
	expect(m9.get(`lane.s9.model`)).toBe("glm-x");
	const m10 = vals("s10");
	expect(m10.get(`lane.s10.executor`)).toBe("claude");
	expect(m10.get(`lane.s10.model`)).toBeUndefined();
});
