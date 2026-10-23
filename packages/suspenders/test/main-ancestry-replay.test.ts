// test/main-ancestry-replay.test.ts — W1206: real historical replay of the
// executor-cv fold over a real repo history. The a81 incident: eleven
// parallel dispatches spent ~110-118s pre-brief because executorCv's fold
// forked `git merge-base --is-ancestor` per distinct historical sha. The
// shared bounded exact-main snapshot in dep-merge-gate serves merged shas
// off ONE `git rev-list -n <bound> main` fork; these cases pin (a) identical
// tallies and (b) the fork count: one snapshot, probes only for misses.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cvKey,
	executorCv,
} from "../hooks/lib/executor-cv.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]): string => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString()}`);
	return p.stdout?.toString().trim() ?? "";
};

const scratchRepo = (): { dir: string; sha: string; project: string } => {
	const d = mkdtempSync(join(tmpdir(), "w1206-replay-"));
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

const commitOnMain = (d: string, i: number): string => {
	writeFileSync(join(d, "f.txt"), `c${i}\n`);
	git(d, "add", ".");
	git(
		d,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		`c${i}`,
	);
	return git(d, "rev-parse", "HEAD");
};

const DDL = [
	"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, payload TEXT)",
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER DEFAULT 1, ts INTEGER)",
	"CREATE TABLE lane_launch_intents (project TEXT, item TEXT, sid TEXT, nonce TEXT, revision INTEGER, executor TEXT, host TEXT, attempt INTEGER, state TEXT, pid INTEGER, birth TEXT, PRIMARY KEY(project,item))",
];

let tick = 0;
const store = (): GovernorStore => {
	const db = new Database(":memory:");
	dbs.push(db);
	for (const sql of DDL) db.run(sql);
	return db as unknown as GovernorStore;
};

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

const replayHistory = (db: GovernorStore, r: { dir: string; project: string }): void => {
	fact(db, "lane.s1.model", "glm-x");
	fact(db, "lane.s3.model", "glm-x");
	db.query(
		"INSERT INTO lane_launch_intents (project, item, sid, nonce, revision, executor, host, attempt, state) VALUES ('p', 'W9', 's2', 'n', 1, 'codex', 'nas', 0, 'REGISTERED')",
	).run();
	const shas: string[] = [];
	for (let i = 0; i < 10; i++) shas.push(commitOnMain(r.dir, i));
	const lane = (sid: string, tag: string): void => {
		for (let i = 0; i < 10; i++) {
			ev(db, "work.claimed", {
				work: `${tag}${i}`,
				by: sid,
				project: r.project,
			});
			ev(db, "work.done", {
				work: `${tag}${i}`,
				sha: shas[i],
				project: r.project,
			});
		}
	};
	lane("s1", "W1");
	lane("s2", "W2");
	// a third lane whose shas never verify: pending orphan + unknown —
	// neither is ever a verdict, so the shared class gains no row
	ev(db, "work.claimed", { work: "W31", by: "s3", project: r.project });
	ev(db, "work.done", { work: "W31", sha: orphanSha(r.dir), project: r.project });
	ev(db, "work.claimed", { work: "W32", by: "s3", project: r.project });
	ev(db, "work.done", { work: "W32", sha: "f".repeat(40), project: r.project });
};

const fact = (db: GovernorStore, key: string, value: string): void => {
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 't', 1)",
	).run(key, value);
};

// W1206 correctness: interleaved lanes fold to per-class consecutive-valid
test("historical replay: interleaved lanes fold to per-class consecutive-valid", () => {
	const db = store();
	const r = scratchRepo();
	replayHistory(db, r);
	const tally = executorCv(db, { host: "h1" });
	expect(tally.get(cvKey("h1", "glm-x"))).toEqual({
		cv: 10,
		valid: 10,
		invalid: 0,
	});
	expect(tally.get(cvKey("nas", "codex"))).toEqual({
		cv: 10,
		valid: 10,
		invalid: 0,
	});
	// the never-verified lane contributes nothing — no guessed rows
	expect(tally.size).toBe(2);
});

// W1206 regression core: the same replay folded by a CHILD process whose
// git is a counting wrapper. One bounded rev-list snapshot serves all
// twenty merged shas; only the two never-verdict misses fall through to the
// per-SHA merge-base probe (fork-per-sha code forked all twenty-two).
test("historical replay forks git once for the snapshot, probes only the misses", () => {
	const r = scratchRepo();
	const bin = mkdtempSync(join(tmpdir(), "w1206-replay-bin-"));
	dirs.push(bin);
	const log = join(bin, "calls.log");
	// counting git wrapper: log argv, then exec the real binary
	writeFileSync(
		join(bin, "git"),
		'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_CALL_LOG"\nexec /usr/bin/git "$@"\n',
	);
	chmodSync(join(bin, "git"), 0o755);
	// file-backed store so the child folds the exact same history
	const storePath = join(bin, "gov.db");
	const db = new Database(storePath);
	for (const sql of DDL) db.run(sql);
	const fdb = db as unknown as GovernorStore;
	fact(fdb, "lane.s1.model", "glm-x");
	fact(fdb, "lane.s3.model", "glm-x");
	db.query(
		"INSERT INTO lane_launch_intents (project, item, sid, nonce, revision, executor, host, attempt, state) VALUES ('p', 'W9', 's2', 'n', 1, 'codex', 'nas', 0, 'REGISTERED')",
	).run();
	const shas: string[] = [];
	for (let i = 0; i < 10; i++) shas.push(commitOnMain(r.dir, i));
	const lane = (sid: string, tag: string): void => {
		for (let i = 0; i < 10; i++) {
			ev(fdb, "work.claimed", {
				work: `${tag}${i}`,
				by: sid,
				project: r.project,
			});
			ev(fdb, "work.done", {
				work: `${tag}${i}`,
				sha: shas[i],
				project: r.project,
			});
		}
	};
	lane("s1", "W1");
	lane("s2", "W2");
	ev(fdb, "work.claimed", { work: "W31", by: "s3", project: r.project });
	ev(fdb, "work.done", {
		work: "W31",
		sha: orphanSha(r.dir),
		project: r.project,
	});
	db.close();
	const child = join(bin, "fold.ts");
	writeFileSync(
		child,
		[
			'import { Database } from "bun:sqlite";',
			`import { executorCv } from "${join(import.meta.dir, "..", "hooks", "lib", "executor-cv.ts")}";`,
			"const db = new Database(process.argv[2], { readonly: true });",
			'const t = executorCv(db as never, { host: "h1" });',
			"console.log(JSON.stringify([...t.entries()]));",
			"",
		].join("\n"),
	);
	const p = Bun.spawnSync([process.execPath, child, storePath], {
		// env built from scratch: the wrapper bin is PATH-first, no operator
		// knobs leak in; the wrapper logs every PATH-resolved git invocation
		env: { PATH: `${bin}:/usr/bin:/bin`, GIT_CALL_LOG: log },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`child fold failed: ${p.stderr?.toString()}`);
	// tallies identical to the in-process fold
	const rows = JSON.parse(p.stdout.toString().trim()) as [
		string,
		{ cv: number; valid: number; invalid: number },
	][];
	expect(Object.fromEntries(rows)).toEqual({
		[cvKey("h1", "glm-x")]: { cv: 10, valid: 10, invalid: 0 },
		[cvKey("nas", "codex")]: { cv: 10, valid: 10, invalid: 0 },
	});
	// one bounded snapshot fork; only the orphan miss takes the probe path
	const lines = readFileSync(log, "utf8")
		.trim()
		.split("\n");
	const revlist = lines.filter((l) => l.includes("rev-list"));
	const mergebase = lines.filter((l) => l.includes("merge-base"));
	expect(revlist.length).toBe(1);
	expect(revlist[0]).toContain("-n 20000 main");
	expect(mergebase.length).toBe(1);
});
