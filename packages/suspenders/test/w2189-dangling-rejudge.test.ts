// w2189-dangling-rejudge.test.ts — W2189 (re-land of W1762): the classifier
// rejudge surface on HEAD's dangling-classify.ts + aggregate repair items.
// Contract: one pass re-judges every OPEN dangling-path repair against the
// CURRENT scoping rules — legacy per-edge items flip to SUPERSEDED, the
// aggregate item rejects per EDGE via code.dangling-reject events; survivors
// and their code.dangling-path edges stay. Second half: a merged classifier
// fix banks a code.dangling-fix event; the dispatch hold keys on the
// INSTALLED harness-receipt revision containing that sha, never on a work
// item's DONE.
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifierRevision,
	danglingFixHolds,
	judgeDanglingEvidence,
	pendingDanglingFixes,
	recordDanglingFix,
	rejudgeDangling,
	type DanglingEvidence,
} from "../hooks/lib/fleet-loop/dangling-rejudge.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { openGovernorDb } from "../hooks/lib/govdb/govdb-open.ts";
import { pinReg } from "../hooks/lib/govdb/govdb-util.ts";

const P = join(import.meta.dir, "..");
const WORK = join(P, "hooks", "bin", "work.ts");

const g = (repo: string, args: [], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

const testEnv = (repo: string) => ({
	...process.env,
	HOME: join(repo, ".test-home"),
	GOVERNOR_STORE_URL: "",
	SUSPENDERS_PREFIX: P,
});

// one temp git repo + temp HOME per fixture; the store lives under .test-home
const base = (): string => {
	const dir = join(
		tmpdir(),
		`w2189-rejudge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(dir, ".test-home"), { recursive: true });
	expect(g(dir, ["init", "-b", "main", "."]).exitCode).toBe(0);
	g(dir, ["config", "user.email", "t@threads.dk"]);
	g(dir, ["config", "user.name", "t"]);
	writeFileSync(join(dir, "f.txt"), "one\n");
	g(dir, ["add", "f.txt"]);
	expect(g(dir, ["commit", "-m", "base"]).exitCode).toBe(0);
	return dir;
};

const storeDb = (repo: string): Database => {
	// openGovernorDb() derives the store path from HOME (= .test-home) and
	// owns schema creation + dir bootstrap — the same channel the CLI child
	// reads. pinReg() re-pins REG_ROOT: the module pinned the LANE's HOME at
	// load, and the CLI child re-resolves from its own .test-home HOME.
	const prev = process.env.HOME;
	process.env.HOME = join(repo, ".test-home");
	try {
		pinReg();
		return openGovernorDb() as unknown as Database;
	} finally {
		process.env.HOME = prev;
	}
};

const run = (repo: string, args: string[]) => {
	const p = Bun.spawnSync(["bun", WORK, ...args], {
		cwd: repo,
		env: testEnv(repo),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`,
	};
};

// seed one repair row + its code.dangling-path event as production banks them
const seed = (
	db: Database,
	project: string,
	id: string,
	title: string,
	ev: DanglingEvidence,
) => {
	db.query(
		"INSERT INTO work_items(project,id,title,state,priority,created_at,updated_at) VALUES(?,?,?,?,0,?,?)",
	).run(project, id, title, "READY", Date.now(), Date.now());
	db.query(
		"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
	).run(Date.now(), "fleet-loop", "code.dangling-path", id, JSON.stringify(ev));
};

const LEGACY = (t: string, by: string) =>
	`Repair dangling path ${t} referenced by ${by}`;

const count = (db: Database, kind: string): number =>
	(
		db
			.query("SELECT COUNT(*) AS c FROM events WHERE kind = ?")
			.get(kind) as { c: number }
	).c;

// W2189-a: the judge rejects the flood classes, keeps the real edges
test("judge applies current scoping rules", () => {
	const kept: DanglingEvidence = {
		target: "packages/telemetry/src/x.ts",
		refBy: "packages/suspenders/hooks/bin/a.ts",
		specifier: "@klh/telemetry/src/x",
		line: 0,
	};
	expect(judgeDanglingEvidence(kept)).toBe(null);
	// probe-1 (line>0): test files ARE judged — a test importing a deleted
	// module is a real dangling edge
	expect(
		judgeDanglingEvidence({
			target: "gone.ts",
			refBy: "test/old.spec.ts",
			specifier: "../gone",
			line: 7,
		}),
	).toBe(null);
	expect(
		judgeDanglingEvidence({
			target: ".worktrees/x/f.ts",
			refBy: "a.ts",
			specifier: "../x/f",
			line: 7,
		}),
	).toBe("runtime-dir target");
	expect(
		judgeDanglingEvidence({
			target: "packages/x/y.mjs",
			refBy: "hooks/bin/b.ts",
			specifier: "packages/x/y.mjs",
			line: 0,
		}),
	).toBe("non-reference-form specifier");
	expect(
		judgeDanglingEvidence({
			target: "packages/x/y.ts",
			refBy: "test/x.test.ts",
			specifier: "../x/y",
			line: 0,
		}),
	).toBe("test-file reference");
});

// W2189-b: one CLI pass supersedes legacy rejects, rejects aggregate edges,
// keeps survivors + edges
test("rejudge CLI supersedes legacy rejects, aggregate edges reject per-edge", () => {
	const repo = base();
	const proj = projectIdentity(repo);
	const db = storeDb(repo);
	seed(db, proj, "W9001", LEGACY("packages/x/y.mjs", "hooks/bin/b.ts"), {
		target: "packages/x/y.mjs",
		refBy: "hooks/bin/b.ts",
		specifier: "packages/x/y.mjs",
		line: 0,
	}); // reject: non-reference-form
	seed(db, proj, "W9002", LEGACY("packages/x/y.ts", "test/x.test.ts"), {
		target: "packages/x/y.ts",
		refBy: "test/x.test.ts",
		specifier: "../x/y",
		line: 0,
	}); // reject: test file
	seed(db, proj, "W9003", LEGACY("packages/x/y.ts", "hooks/bin/a.ts"), {
		target: "packages/x/y.ts",
		refBy: "hooks/bin/a.ts",
		specifier: "../x/y",
		line: 0,
	}); // survivor
	seed(db, proj, "W9004", "Repair dangling paths found by the post-merge scan", {
		target: "packages/x/data.json",
		refBy: "test/x.test.ts",
		specifier: "./x/data.json",
		line: 0,
	}); // aggregate reject: test-file reference
	seed(db, proj, "W9005", "Repair dangling paths found by the post-merge scan", {
		target: "packages/x/y.ts",
		refBy: "hooks/bin/a.ts",
		specifier: "../x/y",
		line: 0,
	}); // aggregate survivor
	const r = run(repo, ["rejudge", "dangling"]);
	expect(r.code).toBe(0);
	expect(r.out).toContain("3 superseded, 2 kept");
	const stateOf = (id: string) =>
		db.query("SELECT state, result_sha FROM work_items WHERE id = ?").get(
			id,
		) as { state: string; result_sha: string | null };
	expect(stateOf("W9001").state).toBe("SUPERSEDED");
	expect(stateOf("W9002").state).toBe("SUPERSEDED");
	expect(stateOf("W9003").state).toBe("READY");
	expect(stateOf("W9001").result_sha).toBe(stateOf("W9002").result_sha);
	expect(stateOf("W9001").result_sha).toMatch(/^[0-9a-f]{40}$/);
	// aggregate stays open; its one reject edge banks code.dangling-reject
	expect(stateOf("W9004").state).toBe("READY");
	expect(count(db, "code.dangling-path")).toBe(5);
	expect(count(db, "work.superseded")).toBe(2);
	expect(count(db, "code.dangling-reject")).toBe(1);
	db.close();
});

// W2189-c: idempotent fix banking + install-keyed hold
test("fix hold keys on the installed receipt revision", () => {
	const repo = base();
	const proj = projectIdentity(repo);
	const db = storeDb(repo);
	// a "fix" commit on a branch; a receipt revision at base does NOT contain it
	g(repo, ["checkout", "-b", "fixbranch"]);
	writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
	g(repo, ["add", "f.txt"]); // never -A: .test-home (the store) is inside the tree
	g(repo, ["commit", "-m", "classifier fix"]);
	const fixSha = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
	g(repo, ["checkout", "main"]);
	// merge.ts opens the store AFTER the git sequence — a handle held open
	// across checkout/commit trips macOS WAL disk-I/O errors, so re-open here
	db.close();
	const db3 = storeDb(repo);
	const prefix = join(repo, "receipts");
	mkdirSync(prefix, { recursive: true });
	const rev = (sha: string) =>
		writeFileSync(
			join(prefix, "harness-receipt.json"),
			JSON.stringify({ schema: "fleet.harness.v1", revision: sha }),
		);
	rev(g(repo, ["rev-parse", "main"]).stdout.toString().trim());
	expect(recordDanglingFix(db3, proj, fixSha)).toBe(true);
	expect(recordDanglingFix(db3, proj, fixSha)).toBe(false); // idempotent
	// base revision lacks the fix → pending (hold)
	expect(pendingDanglingFixes(db3, repo, prefix).map((f) => f.sha)).toEqual([
		fixSha,
	]);
	// a revision containing the fix → no hold
	const m = g(repo, ["merge", "--no-ff", "--no-edit", "fixbranch"]);
	expect(m.exitCode).toBe(0);
	rev(g(repo, ["rev-parse", "main"]).stdout.toString().trim());
	expect(pendingDanglingFixes(db3, repo, prefix)).toEqual([]);
	// the hold freezes repair-titled rows only — aggregate title included
	const holds = danglingFixHolds(db3, repo, [
		{ id: "W9101", title: "Repair dangling path a referenced by b" },
		{ id: "W9102", title: "Repair dangling paths found by the post-merge scan" },
		{ id: "W9103", title: "Unrelated work" },
	]);
	expect([...holds.keys()]).toEqual(["W9101", "W9102"]);
	db3.close();
});

// rejudgeDangling library face: dry-run touches nothing
test("rejudge dry-run reports without mutating", () => {
	const repo = base();
	const proj = projectIdentity(repo);
	const db = storeDb(repo);
	seed(db, proj, "W9201", LEGACY("packages/x/y.mjs", "hooks/bin/b.ts"), {
		target: "packages/x/y.mjs",
		refBy: "hooks/bin/b.ts",
		specifier: "packages/x/y.mjs",
		line: 0,
	});
	const r = rejudgeDangling(db, repo, { dryRun: true });
	if ("error" in r) throw new Error(r.error);
	expect(r.superseded).toEqual([
		{ id: "W9201", reason: "non-reference-form specifier" },
	]);
	expect(
		(
			db.query("SELECT state FROM work_items WHERE id = ?").get("W9201") as {
				state: string;
			}
		).state,
	).toBe("READY");
	db.close();
});

// the classifier revision the rejudge cites — latest of the two classifier
// files, falling back to HEAD in a fresh fixture
test("classifierRevision cites the latest classifier commit", () => {
	const repo = base();
	expect(classifierRevision(repo)).toMatch(/^[0-9a-f]{40}$/);
});
