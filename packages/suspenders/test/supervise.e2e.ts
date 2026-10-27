// test/supervise.test.ts — W146: the micro-supervisor loop. Covered against
// a REAL scratch governor db + scratch repo (same rig as dispatch-next's
// tests): dry-run prints the plan with zero side effects; a childless parent
// with no titles escalates NEED_DECISION to its coordinator; supervisor-run
// shatter + dispatch; scope isolation (sibling subtree untouched, parent
// chain check via inScope); idempotent restart (same-sid resume, no
// double-claim, dep-order dispatch); integration (verify-mode escalation for
// an unmerged sha, merge-mode lands the branch and the subtree closes with
// evidence fact + capsule).

import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inScope } from "../scripts/supervise.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w146-sup-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-w146-sup-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = {
	...process.env,
	HOME,
	PATH: `${join(HOME, "bin")}:${process.env.PATH}`,
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");
// fake claude: supervise spawns this instead of a real lane (tests never
// spawn real lanes — dry-run + scratch db only). W576.1 rig: the launch
// fence refuses an executor that exits inside its 1s startup window, so
// the fake holds until the unblock file appears; a crash file makes it
// die instantly for the poison-budget test.
const FAKE = join(HOME, "bin", "claude");
const CRASH = join(HOME, ".lane-crash");
const UNBLOCK = join(HOME, ".lane-unblock");
mkdirSync(join(HOME, "bin"), { recursive: true });
writeFileSync(
	FAKE,
	`#!/bin/sh\nif [ -f "${CRASH}" ]; then exit 1; fi\nwhile [ ! -f "${UNBLOCK}" ]; do sleep 0.1; done\n`,
);
chmodSync(FAKE, 0o755);

test.afterAll(async () => {
	try {
		writeFileSync(UNBLOCK, "1");
		await Bun.sleep(1500);
	} catch {}
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

import { spawnSync } from "node:child_process";

const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
writeFileSync(join(REPO, "README.md"), "x");
// runtime lane artifacts stay untracked (as in the real fleet repo) — a
// tracked context file would cross the integrate-merge into main and trip
// the completion-context identity check of the NEXT lane
writeFileSync(join(REPO, ".gitignore"), ".fleet/\n.worktrees/\n");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const tool = (bin: string, ...args: string[]) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(
			`${bin} ${args.join(" ")} failed (${p.exitCode}): ${p.stderr.toString()}`,
		);
	return { out: p.stdout.toString(), code: p.exitCode ?? 1 };
};
const sup = (...args: string[]) => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "supervise.ts"),
			...args,
			"--grace-ms",
			"0",
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};
// async variant for the concurrent-controller tests: both sups race live
const supAsync = (
	...args: string[]
): Promise<{
	out: string;
	err: string;
	code: number | null;
}> => {
	const proc = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "supervise.ts"),
			...args,
			"--grace-ms",
			"0",
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	return Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]).then(([out, err, code]) => ({ out, err, code }));
};

const PROJECT = realpathSync(
	resolve(
		REPO,
		spawnSync("/usr/bin/git", ["-C", REPO, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
		}).stdout.trim(),
	),
);
const db = () =>
	new Database(`${HOME}/.cache/claude-governor/governor.db`, {
		readonly: true,
	});

const addItem = (title: string): string => {
	const r = tool("work.ts", "add", title);
	const id = (r.out.match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};
const state = (
	id: string,
): {
	state: string;
	owner_sid: string | null;
	result_sha: string | null;
	updated_at: number;
} => {
	const d = db();
	const row = d
		.query(
			"SELECT state, owner_sid, result_sha, updated_at FROM work_items WHERE project = ? AND id = ?",
		)
		.get(PROJECT, id) as
		| {
				state: string;
				owner_sid: string | null;
				result_sha: string | null;
				updated_at: number;
		  }
		| undefined;
	d.close();
	if (!row) throw new Error(`no item ${id}`);
	return row;
};
const decisionEvents = (target: string): { note: string }[] => {
	const d = db();
	const rows = d
		.query(
			"SELECT payload FROM events WHERE kind = 'NEED_DECISION' AND target = ?",
		)
		.all(target) as { payload: string }[];
	d.close();
	return rows.map((r) => JSON.parse(r.payload) as { note: string });
};
const factValue = (key: string): string | null => {
	const d = db();
	const row = d.query("SELECT value FROM facts WHERE key = ?").get(key) as
		| { value: string }
		| undefined;
	d.close();
	return row?.value ?? null;
};
const sidOf = (item: string): string =>
	`autow${item.replace(/^W/, "").replace(/\./g, "-")}`;
const supSid = (item: string): string =>
	`sup${item.replace(/^W/, "").replace(/\./g, "-")}`;
const commitIn = (wt: string, msg: string): string => {
	writeFileSync(join(wt, "feature.txt"), msg);
	g(["-C", wt, "add", "-A"]);
	g(["-C", wt, "commit", "-m", msg]);
	return spawnSync("/usr/bin/git", ["-C", wt, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).stdout.trim();
};
const ancestorOfMain = (sha: string): boolean =>
	spawnSync(
		"/usr/bin/git",
		["-C", REPO, "merge-base", "--is-ancestor", sha, "main"],
		{ encoding: "utf8" },
	).status === 0;
// W576.1 rig: registry reads + deterministic lane death for the fence
const registryRows = (): { sid: string; item: string; attempt?: number }[] =>
	JSON.parse(readFileSync(join(REPO, ".fleet", "lanes.json"), "utf8")) as {
		sid: string;
		item: string;
		attempt?: number;
	}[];
const waitDead = async (pid: number): Promise<void> => {
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await Bun.sleep(50);
	}
	throw new Error(`lane ${pid} never died`);
};
const killLanes = async (): Promise<void> => {
	// wait only on pids ALIVE at kill time — never on accumulated registry
	// rows (recycled pids hang the wait and cascade failures downstream)
	const alive = registryRows()
		.map((r) => (r as { pid?: number }).pid)
		.filter((p): p is number => typeof p === "number")
		.filter((p) => {
			try {
				process.kill(p, 0);
				return true;
			} catch {
				return false;
			}
		});
	writeFileSync(UNBLOCK, "1");
	await Promise.all(alive.map((p) => waitDead(p).catch(() => {})));
	rmSync(UNBLOCK, { force: true });
};

test.describe("W146 micro-supervisor", () => {
	test("dry-run prints the plan with zero side effects", () => {
		const p = addItem("dry run fixture parent");
		tool("work.ts", "split", p, "kid a", "kid b", "--reason", "fixture");
		const kids = spawnSync(
			"/usr/bin/git",
			["-C", REPO, "rev-parse", "--git-common-dir"],
			{ encoding: "utf8" },
		);
		expect(kids.status).toBe(0);
		const r = sup(p, "--dry-run", "--once");
		expect(r.code).toBe(0);
		expect(r.out).toContain("DRY dispatch");
		// no state change: children still READY, no fleet/worktree writes
		const show = tool("work.ts", "show", p);
		expect(show.out).toContain("SHATTERED");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		expect(existsSync(join(REPO, ".fleet"))).toBe(false);
	});

	test("childless parent with no titles escalates NEED_DECISION (once)", () => {
		const p = addItem("childless fixture parent");
		const r = sup(p, "--once", "--to", "coord-a");
		expect(r.out).toContain("NEED_DECISION");
		const events = decisionEvents("coord-a");
		expect(events.length).toBe(1);
		expect(events[0].note).toContain(p);
		// second run: journal dedupes — no repeat escalation
		sup(p, "--once", "--to", "coord-a");
		expect(decisionEvents("coord-a").length).toBe(1);
		// parent untouched
		expect(state(p).state).toBe("READY");
	});

	test("supervisor-run shatter dispatches the fresh children", async () => {
		const p = addItem("shatter fixture parent");
		const r = sup(p, "kid one", "kid two", "--once");
		expect(r.out).toContain("shattering");
		const show = tool("work.ts", "show", p);
		expect(show.out).toContain(`${p}.1`);
		const s1 = state(`${p}.1`);
		const s2 = state(`${p}.2`);
		expect(s1.state).toBe("CLAIMED");
		expect(s1.owner_sid).toBe(sidOf(`${p}.1`));
		expect(s2.state).toBe("CLAIMED");
		expect(existsSync(join(REPO, ".worktrees", `${p}.1`))).toBe(true);
		await killLanes();
	}, 30000);

	test("scope isolation: sibling subtree untouched, inScope walks chains", async () => {
		const p = addItem("scope fixture parent");
		tool("work.ts", "split", p, "mine a", "mine b", "--reason", "fixture");
		const other = addItem("foreign parent");
		tool("work.ts", "add", "not mine", "--parent", other);
		const d = db();
		expect(inScope(d, PROJECT, p, `${p}.1`)).toBe(true);
		expect(inScope(d, PROJECT, p, p)).toBe(true);
		expect(inScope(d, PROJECT, p, `${other}.1`)).toBe(false);
		const grand = tool("work.ts", "add", "grandkid", "--parent", `${p}.1`);
		const gid = (grand.out.match(/W[\d.]+/) ?? [])[0] ?? "";
		expect(gid).toContain(".");
		expect(inScope(d, PROJECT, p, gid)).toBe(true);
		d.close();
		const r = sup(p, "--once");
		expect(r.out).toContain(`dispatched ${p}.1`);
		// the foreign child was never touched
		expect(state(`${other}.1`).state).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", `${other}.1`))).toBe(false);
		await killLanes();
	}, 30000);

	test("restart resumes same-sid; dep order; integrate; close with evidence", async () => {
		const p = addItem("dep-order fixture parent");
		tool("work.ts", "split", p, "first", "second", "--reason", "fixture");
		const c1 = `${p}.1`;
		const c2 = `${p}.2`;
		tool("work.ts", "block", c2, "--on", c1);
		// run 1: only the dep-free child dispatches
		const r1 = sup(p, "--once");
		expect(r1.out).toContain(`dispatched ${c1}`);
		expect(r1.out).not.toContain(`dispatched ${c2}`);
		expect(state(c1).owner_sid).toBe(sidOf(c1));
		expect(state(c2).state).toBe("READY");
		// run 2 (restart): dead lane resumed under the SAME sid — no re-claim
		// (W576.1: the fence needs the intent PROVEN dead first — unblock+wait)
		writeFileSync(UNBLOCK, "1");
		await waitDead(Number((r1.out.match(/pid (\d+)/) ?? [])[1] ?? 0));
		rmSync(UNBLOCK, { force: true });
		const r2 = sup(p, "--once");
		expect(r2.out).toContain(`dispatched ${c1}`);
		expect(r2.out).toContain("resumed from capsule");
		expect(state(c1).owner_sid).toBe(sidOf(c1));
		// registry dedupes by sid — one row per lane, attempt bumped
		const rows = registryRows().filter((l) => l.sid === sidOf(c1));
		expect(rows).toHaveLength(1);
		expect(rows[0].attempt).toBe(1); // attempt is 0-based: first launch 0, resume 1
		// the lane finishes: commit on its branch, mark DONE (landing chain)
		writeFileSync(
			join(REPO, ".worktrees", c1, "oversized.ts"),
			"// line\n".repeat(1501),
		);
		const sha1 = commitIn(join(REPO, ".worktrees", c1), "first child work");
		// completion law: a dispatched close needs the final capsule checkpoint
		tool(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			sidOf(c1),
			`--checkpoint=${sha1}`,
			"--done=first child work complete on its branch, ready for integration",
			"--file=feature.txt",
			"--next=merge into main",
		);
		expect(
			tool("work.ts", "done", c1, "--sha", sha1, "--as", sidOf(c1)).code,
		).toBe(0);
		// run 3: verify mode — DONE-but-unmerged sha escalates, never closes
		const r3 = sup(p, "--once", "--integrate", "verify", "--to", "coord-a");
		expect(r3.out).toContain("NEED_DECISION");
		expect(decisionEvents("coord-a").some((e) => e.note.includes(c1))).toBe(
			true,
		);
		// run 4: merge mode — the child branch lands on main
		const r4 = sup(p, "--once", "--integrate", "merge");
		expect(r4.out).toContain("integrating");
		expect(ancestorOfMain(sha1)).toBe(true);
		expect(factValue(`supervise.${p.toLowerCase()}.integrated`)).toContain(c1);
		const checkDb = db();
		const followup = checkDb
			.query(
				"SELECT id, description FROM work_items WHERE project = ? AND title = 'DRY and decompose oversized.ts'",
			)
			.all(PROJECT) as { id: string; description: string }[];
		expect(followup).toHaveLength(1);
		expect(followup[0].description).toContain(
			"import them from the original entrypoint",
		);
		checkDb.close();
		// run 5: with the dep merged, the blocked child is now dispatchable
		const r5 = sup(p, "--once", "--integrate", "merge");
		expect(r5.out).toContain(`dispatched ${c2}`);
		await killLanes();
		// the second lane finishes straight on main (already integrated)
		const sha2 = commitIn(REPO, "second child work");
		tool(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			sidOf(c2),
			`--checkpoint=${sha2}`,
			"--done=second child work complete on main after dep merged",
			"--file=feature.txt",
			"--next=none",
		);
		expect(
			tool("work.ts", "done", c2, "--sha", sha2, "--as", sidOf(c2)).code,
		).toBe(0);
		// run 6: subtree terminal + integrated → close with evidence
		const r6 = sup(p, "--once", "--integrate", "merge");
		if (r6.code !== 0) throw new Error(`run6 failed: ${r6.err}\n${r6.out}`);
		expect(r6.code).toBe(0);
		expect(r6.out).toContain("CLOSED");
		expect(state(p).state).toBe("DONE");
		expect(factValue(`supervise.${p.toLowerCase()}.closed`)).toContain(p);
		const cap = tool("coord.ts", "capsule", "get", "--as", supSid(p));
		expect(cap.out).toContain("subtree closed");
		// interfaces down: the child brief carried the aids + supervision stanzas
		const brief = readFileSync(
			join(REPO, ".fleet", `brief-${sidOf(c1)}.md`),
			"utf8",
		);
		expect(brief).toContain("AIDS (knowledge interfaces):");
		expect(brief).toContain("SUPERVISION:");
		expect(brief).toContain("aids: (preseeding placeholder");
	}, 120000);

	// W576.1: two supervise processes race for the same child pool — the
	// governed launch authority (lease + claim CAS + intent fence) keeps
	// every child exactly-once across both controllers.
	test("W576.1: simultaneous controllers dispatch each child exactly once", async () => {
		const p = addItem("contended fixture parent");
		tool("work.ts", "split", p, "one", "two", "--reason", "fixture");
		const [a, b] = await Promise.all([
			supAsync(p, "--once"),
			supAsync(p, "--once"),
		]);
		const both = `${a.out}\n${b.out}`;
		expect(both).toContain("dispatched"); // diagnostic: prints sup outputs on fail
		const rows = registryRows();
		for (const kid of [`${p}.1`, `${p}.2`]) {
			const count = (both.match(new RegExp(`dispatched ${kid} → `, "g")) ?? [])
				.length;
			expect(count).toBe(1);
			expect(rows.filter((r) => r.sid === sidOf(kid))).toHaveLength(1);
			expect(state(kid).owner_sid).toBe(sidOf(kid));
		}
		await killLanes();
	}, 60000);

	// W576.1: a poison item burns the SHARED launch budget (no per-entrypoint
	// retry reset) and then quarantines into NEED_DECISION — repeated runs
	// cannot resurrect it, and the escalation is journal-deduped.
	test("W576.1: poisoned item exhausts the shared budget, escalates once", async () => {
		const p = addItem("poison fixture parent");
		tool("work.ts", "add", "cursed", "--parent", p);
		writeFileSync(CRASH, "1");
		const refused = (r: { out: string }): number =>
			(r.out.match(new RegExp(`REFUSED ${p}\\.1`, "g")) ?? []).length;
		for (let i = 0; i < 3; i++) {
			const r = sup(p, "--once");
			expect(refused(r)).toBe(1);
			expect(r.out).not.toContain("budget exhausted");
			expect(state(`${p}.1`).state).toBe("READY");
		}
		const r4 = sup(p, "--once", "--to", "coord-b");
		expect(r4.out).toContain("budget exhausted");
		expect(decisionEvents("coord-b")).toHaveLength(1);
		const r5 = sup(p, "--once", "--to", "coord-b");
		expect(r5.out).toContain("budget exhausted");
		expect(decisionEvents("coord-b")).toHaveLength(1);
		rmSync(CRASH, { force: true });
		expect(state(`${p}.1`).state).toBe("READY");
	}, 60000);

	// W576.1: a stale supervisor can neither release nor resume a claim that
	// moved — structured ownership only: a foreign CLAIMED item is skipped
	// untouched (claim preserved with its new owner).
	test("W576.1: stale owner cannot release or resume a moved claim", async () => {
		const p = addItem("stale fixture parent");
		tool("work.ts", "add", "mine", "--parent", p);
		const r1 = sup(p, "--once");
		expect(r1.out).toContain(`dispatched ${p}.1`);
		await killLanes();
		// coordinator CAS-reclaims the orphaned claim, a foreign lane claims it
		const rev = state(`${p}.1`).updated_at;
		expect(
			tool(
				"work.ts",
				"reclaim",
				`${p}.1`,
				"--expect-owner",
				sidOf(`${p}.1`),
				"--expect-updated-at",
				String(rev),
			).code,
		).toBe(0);
		tool("work.ts", "take", `${p}.1`, "--as", "foreignlane");
		// the stale supervisor never reaches the launch path: the resume
		// gate's structured ownership check skips the moved claim untouched
		const r2 = sup(p, "--once");
		expect(r2.out).not.toContain(`dispatched ${p}.1`);
		expect(r2.out).not.toContain("REFUSED");
		expect(state(`${p}.1`).state).toBe("CLAIMED");
		expect(state(`${p}.1`).owner_sid).toBe("foreignlane");
	}, 60000);
});
