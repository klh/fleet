// test/w1762-dangling-rejudge@unit.e2e.ts — W1762 (re-land via W2223): the
// dangling-path classifier's rejudge surface. Contract: one pass re-judges
// every OPEN dangling-path repair against the CURRENT classifier rules
// (W1302.8 isPathForm / fixture-class refBy / unjudged targets) and
// supersedes the rejects with the classifier sha as the recorded reason —
// survivors and their code.dangling-path edges stay. Second half: a merged
// classifier fix banks a code.dangling-fix event; the dispatch hold keys on
// the INSTALLED harness-receipt revision containing that sha, never on a
// work item's DONE. Fixture: @klh/test-kit scratchWorld (isolated HOME +
// real git repo, W1135.1.3).

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	type DanglingEvidence,
	danglingFixHolds,
	judgeDanglingEvidence,
	pendingDanglingFixes,
	recordDanglingFix,
	rejudgeDangling,
} from "../hooks/lib/fleet-loop/dangling-rejudge.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { openGovernorDb } from "../hooks/lib/govdb/govdb-open.ts";
import { pinReg } from "../hooks/lib/govdb/govdb-util.ts";

const P = join(import.meta.dir, "..");
const WORK = join(P, "hooks", "bin", "work.ts");

const g = (repo: string, args: string[]) =>
	Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

/** In-process store over the scratch HOME: openGovernorDb derives the db
 * path from HOME, pinReg re-pins the module-level root for this spec's
 * env (the module pinned the process HOME at load). */
const storeDb = (home: string): Database => {
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		pinReg();
		return openGovernorDb() as unknown as Database;
	} finally {
		process.env.HOME = prev;
	}
};

// seed one repair row + its code.dangling-path event as production banks them
const seed = (
	db: Database,
	project: string,
	id: string,
	ev: DanglingEvidence,
) => {
	db.query(
		"INSERT INTO work_items(project,id,title,state,priority,created_at,updated_at) VALUES(?,?,?,?,0,?,?)",
	).run(
		project,
		id,
		`Repair dangling path ${ev.target} referenced by ${ev.refBy}`,
		"READY",
		Date.now(),
		Date.now(),
	);
	db.query(
		"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
	).run(Date.now(), "fleet-loop", "code.dangling-path", id, JSON.stringify(ev));
};

const count = (db: Database, kind: string): number =>
	(
		db.query("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind) as {
			c: number;
		}
	).c;

/** The rejudge verb rides the CLI child over the scratch world (same env
 * pins the CLI reads: HOME for the store, no inherited store URL). */
const runRejudge = (w: ReturnType<typeof scratchWorld>) => {
	const p = Bun.spawnSync(["bun", WORK, "rejudge", "dangling"], {
		cwd: w.repo,
		env: { ...process.env, HOME: w.home, GOVERNOR_STORE_URL: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`,
	};
};

test("judge applies current scoping rules @unit", () => {
	const kept: DanglingEvidence = {
		target: "packages/telemetry/src/x.ts",
		refBy: "packages/suspenders/hooks/bin/a.ts",
		specifier: "@klh/telemetry/src/x",
		line: 0,
	};
	expect(judgeDanglingEvidence(kept)).toBe(null);
	// probe-1 (line>0): fixture files ARE judged — a test importing a deleted
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
	).toBe("fixture-file reference");
	// W2223 port coverage: inert files and build-output targets reject under
	// the current classifier's wider vocabulary
	expect(
		judgeDanglingEvidence({
			target: "packages/x/y.ts",
			refBy: "test/fixtures/f.ts",
			specifier: "../x/y",
			line: 0,
		}),
	).toBe("fixture-file reference");
	expect(
		judgeDanglingEvidence({
			target: "dist/bundle.js",
			refBy: "a.ts",
			specifier: "../dist/bundle",
			line: 0,
		}),
	).toBe("runtime-dir target");
});

test("rejudge CLI supersedes rejects, keeps survivors and edges @unit", () => {
	const w = scratchWorld({ prefix: "w1762-rejudge-" });
	try {
		const proj = projectIdentity(w.repo);
		const db = storeDb(w.home);
		seed(db, proj, "W9001", {
			target: "packages/x/y.mjs",
			refBy: "hooks/bin/b.ts",
			specifier: "packages/x/y.mjs",
			line: 0,
		}); // reject: non-reference-form
		seed(db, proj, "W9002", {
			target: "packages/x/y.ts",
			refBy: "test/x.test.ts",
			specifier: "../x/y",
			line: 0,
		}); // reject: fixture-class refBy
		seed(db, proj, "W9003", {
			target: "packages/x/y.ts",
			refBy: "hooks/bin/a.ts",
			specifier: "../x/y",
			line: 0,
		}); // survivor
		const r = runRejudge(w);
		expect(r.code).toBe(0);
		expect(r.out).toContain("2 superseded, 1 kept");
		const stateOf = (id: string) =>
			db
				.query("SELECT state, result_sha FROM work_items WHERE id = ?")
				.get(id) as { state: string; result_sha: string | null };
		expect(stateOf("W9001").state).toBe("SUPERSEDED");
		expect(stateOf("W9002").state).toBe("SUPERSEDED");
		expect(stateOf("W9003").state).toBe("READY");
		expect(stateOf("W9001").result_sha).toBe(stateOf("W9002").result_sha);
		expect(stateOf("W9001").result_sha).toMatch(/^[0-9a-f]{40}$/);
		// edges preserved for every finding; rejects bank work.superseded
		expect(count(db, "code.dangling-path")).toBe(3);
		expect(count(db, "work.superseded")).toBe(2);
		db.close();
	} finally {
		w.clean();
	}
});

test("fix hold keys on the installed receipt revision @unit", () => {
	const w = scratchWorld({ prefix: "w1762-fixhold-" });
	try {
		const proj = projectIdentity(w.repo);
		const db = storeDb(w.home);
		const baseBranch = g(w.repo, ["rev-parse", "--abbrev-ref", "HEAD"])
			.stdout.toString()
			.trim();
		// close the store before the git leg (macOS WAL disk-I/O hazard when a
		// handle is held across checkout/commit — merge.ts opens it after)
		db.close();
		g(w.repo, ["checkout", "-q", "-b", "fixbranch"]);
		writeFileSync(join(w.repo, "f.txt"), "one\ntwo\n");
		g(w.repo, ["add", "f.txt"]);
		g(w.repo, [
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@threads.dk",
			"commit",
			"-qm",
			"classifier fix",
		]);
		const fixSha = g(w.repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		g(w.repo, ["checkout", "-q", baseBranch]);
		const db3 = storeDb(w.home);
		const prefix = join(w.repo, "receipts");
		mkdirSync(prefix, { recursive: true });
		const rev = (sha: string) =>
			writeFileSync(
				join(prefix, "harness-receipt.json"),
				JSON.stringify({ schema: "fleet.harness.v1", revision: sha }),
			);
		rev(g(w.repo, ["rev-parse", baseBranch]).stdout.toString().trim());
		expect(recordDanglingFix(db3, proj, fixSha)).toBe(true);
		expect(recordDanglingFix(db3, proj, fixSha)).toBe(false); // idempotent
		expect(pendingDanglingFixes(db3, w.repo, prefix).map((f) => f.sha)).toEqual(
			[fixSha],
		);
		// a revision containing the fix → no hold
		expect(
			g(w.repo, ["merge", "--no-ff", "--no-edit", "-q", "fixbranch"]).exitCode,
		).toBe(0);
		rev(g(w.repo, ["rev-parse", baseBranch]).stdout.toString().trim());
		expect(pendingDanglingFixes(db3, w.repo, prefix)).toEqual([]);
		// the hold freezes only repair-titled rows
		const holds = danglingFixHolds(db3, w.repo, [
			{ id: "W9101", title: "Repair dangling path a referenced by b" },
			{ id: "W9102", title: "Unrelated work" },
		]);
		expect([...holds.keys()]).toEqual(["W9101"]);
		db3.close();
	} finally {
		w.clean();
	}
});

test("rejudge dry-run reports without mutating @unit", () => {
	const w = scratchWorld({ prefix: "w1762-dryrun-" });
	try {
		const proj = projectIdentity(w.repo);
		const db = storeDb(w.home);
		seed(db, proj, "W9201", {
			target: "packages/x/y.mjs",
			refBy: "hooks/bin/b.ts",
			specifier: "packages/x/y.mjs",
			line: 0,
		});
		const r = rejudgeDangling(
			db as unknown as Parameters<typeof rejudgeDangling>[0],
			w.repo,
			{ dryRun: true },
		);
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
	} finally {
		w.clean();
	}
});
