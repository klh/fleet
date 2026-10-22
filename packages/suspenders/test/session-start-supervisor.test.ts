// session-start-supervisor.test.ts — W637: the SessionStart hook renders the
// supervisor-default arm-loop directive when the project's READY pool holds
// work (compliance by injection, not model-recall). Top-level sessions only —
// a subagent lane is not a loop-arming runtime. Isolated temp HOME + repos,
// spawns the real hook.
import { describe, test, expect, afterAll } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { projectIdentity } from "../hooks/lib/govdb.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	acquireControllerLease,
	currentControllerIdentity,
} from "../scripts/lib/controller-fence.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-sup-"));
const REPO_A = mkdtempSync(join(tmpdir(), "suspenders-sup-repo-a-"));
const REPO_B = mkdtempSync(join(tmpdir(), "suspenders-sup-repo-b-"));
mkdirSync(join(REPO_B, ".git"), { recursive: true });
// harness lane identity must not leak into the spawned hook: a live
// SUSPENDERS_SID + canonical-v1 protocol trips the declared-lane gate for
// the test's own sid, and a real front + belt.env would mint real keys
const env: Record<string, string | undefined> = { ...process.env, HOME };
env.TMPDIR = HOME;
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
// W1124.12: a lane-role session never renders the supervisor directive —
// strip the ambient role marker so a harness lane cannot leak it in.
delete env.KLH_SESSION_ROLE;
env.SUSPENDERS_BUCKLE_FRONT = "http://127.0.0.1:1";
env.SUSPENDERS_BELT_ENV = join(HOME, "absent-belt.env");
const hook = join(import.meta.dir, "..", "hooks", "session-start.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const PROJECT_B = projectIdentity(REPO_B);
const PARENT = "sup-sess-22222222";

function runHook(cwd: string, tp: string) {
	const payload = join(
		HOME,
		`payload-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: PARENT,
			source: "startup",
			transcript_path: tp,
			cwd,
		}),
	);
	const p = Bun.spawnSync(["bun", hook], {
		cwd,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

function seedReady(project: string): void {
	const db = new Database(DB);
	db.run(
		"INSERT INTO work_items (project, id, title, state, priority, required, created_at, updated_at) VALUES (?, 'WSUP1', 'seed item', 'READY', 0, 1, ?, ?)",
		[project, Date.now(), Date.now()],
	);
	db.close();
}

function runWork(cwd: string, args: string[]) {
	return Bun.spawnSync(
		["bun", join(import.meta.dir, "../hooks/bin/work.ts"), ...args],
		{ cwd, env, stdout: "pipe", stderr: "pipe" },
	);
}

function runPush(
	cwd: string,
	command: string,
	extra: Record<string, unknown> = {},
) {
	const payload = join(
		HOME,
		`push-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: PARENT,
			cwd,
			tool_name: "Bash",
			tool_input: { command },
			...extra,
		}),
	);
	const p = Bun.spawnSync(
		["bun", join(import.meta.dir, "../hooks/gate.ts"), "push"],
		{ cwd, env, stdin: Bun.file(payload), stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO_A, { recursive: true, force: true });
	rmSync(REPO_B, { recursive: true, force: true });
});

describe("supervisor-default directive (W637)", () => {
	test("W1069: fresh non-fleet session (READY=0) receives the contract notice", () => {
		const r = runHook(REPO_A, join(HOME, "tp-a.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("SUPERVISOR DEFAULT");
		expect(r.out).toContain("SUPERVISOR CONTRACT");
		expect(r.out).not.toContain("/loop refill");
		expect(r.out).not.toContain("work reclaim all");
		expect(r.out).toContain("canonical guarded landing");
		expect(r.out).toContain("controller=absent");
		expect(r.out).toContain("not a grant of controller authority");
	});

	test("work added after empty SessionStart notifies once without arming through PostToolUse", () => {
		const first = runWork(REPO_A, ["add", "first new work"]);
		expect(first.exitCode).toBe(0);
		const command =
			"bun ~/.claude/hooks/suspenders/bin/work.ts add 'first new work'";
		const prompt = runPush(REPO_A, command);
		expect(prompt.code).toBe(0);
		expect(prompt.out).toContain("SUPERVISOR DEFAULT: READY 1 > 0");
		expect(prompt.out).not.toContain("/loop refill");
		expect(prompt.out).toContain("advisory only");
		expect(runPush(REPO_A, command).out).not.toContain("SUPERVISOR DEFAULT");
		const second = runWork(REPO_A, ["add", "another new work"]);
		expect(second.exitCode).toBe(0);
		expect(runPush(REPO_A, command).out).not.toContain("SUPERVISOR DEFAULT");
	});

	test("native child hook never receives the supervisor directive", () => {
		const repo = mkdtempSync(join(tmpdir(), "suspenders-sup-child-"));
		try {
			expect(runHook(repo, join(HOME, "child-parent.jsonl")).code).toBe(0);
			expect(runWork(repo, ["add", "child created work"]).exitCode).toBe(0);
			const r = runPush(repo, "work add 'child created work'", {
				agent_id: "native-agent-1",
			});
			expect(r.out).not.toContain("SUPERVISOR DEFAULT");
			expect(runPush(repo, "work add 'child created work'").out).toContain(
				"SUPERVISOR DEFAULT",
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("split from a claimed parent wakes an empty supervisor through its inbox", () => {
		const repo = mkdtempSync(join(tmpdir(), "suspenders-sup-split-"));
		try {
			expect(runHook(repo, join(HOME, "split-parent.jsonl")).code).toBe(0);
			const project = projectIdentity(repo);
			const db = new Database(DB);
			db.run(
				"INSERT INTO work_items (project, id, title, state, priority, owner_sid, required, created_at, updated_at) VALUES (?, 'WSPLIT', 'parent', 'CLAIMED', 0, ?, 1, ?, ?)",
				[project, PARENT, Date.now(), Date.now()],
			);
			db.close();
			const split = runWork(repo, [
				"split",
				"WSPLIT",
				"first child",
				"second child",
				"--reason",
				"independent-scopes",
			]);
			expect(split.exitCode).toBe(0);
			const log = join(
				HOME,
				".claude-insights",
				`coord-subscribe-${PARENT}.log`,
			);
			appendFileSync(log, "#1 work.shattered WSPLIT\n");
			const prompt = runPush(repo, "true");
			expect(prompt.out).toContain("SUPERVISOR DEFAULT: READY 2 > 0");
			expect(runPush(repo, "true").out).not.toContain("SUPERVISOR DEFAULT");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("top-level start with READY>0 renders advisory guidance without a loop", () => {
		const first = runHook(REPO_B, join(HOME, "tp-b.jsonl"));
		expect(first.code).toBe(0);
		seedReady(PROJECT_B);
		const r = runHook(REPO_B, join(HOME, "tp-b.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("SUPERVISOR DEFAULT");
		expect(r.out).not.toContain("/loop refill");
		expect(r.out).toContain("READY 1");
		expect(r.out).toContain("coord message <sid>");
		expect(r.out).toContain("never cancel the lane just to revise its prompt");
	});

	test("canonical live controller and both holds are observed without granting a second loop", () => {
		mkdirSync(join(REPO_B, ".fleet"), { recursive: true });
		writeFileSync(join(REPO_B, ".fleet/dispatch-paused"), "deployment hold");
		writeFileSync(join(REPO_B, ".fleet/reclaim-paused"), "recovery hold");
		const db = new Database(DB);
		try {
			expect(
				acquireControllerLease(
					db as unknown as GovernorStore,
					PROJECT_B,
					currentControllerIdentity("fixture-controller", import.meta.path),
				),
			).toBe(true);
		} finally {
			db.close();
		}
		const r = runHook(REPO_B, join(HOME, "held-controller.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("controller=alive; dispatch=held; reclaim=held");
		expect(r.out).toContain("Snapshot is not authorization");
		expect(r.out).not.toContain("/loop refill");
		expect(r.out).not.toContain("prune --all-dead");
		expect(r.out).not.toContain("work reclaim all");
	});

	test("W899: the directive carries the emitted report table", () => {
		const r = runHook(REPO_B, join(HOME, "tp-b.jsonl"));
		expect(r.code).toBe(0);
		// the W892 table renders right under the directive: fixed header
		// (ITEM/ST/TASK/TOKENS) and the seeded WSUP1 row in Q state
		expect(r.out).toContain("ITEM");
		expect(r.out).toContain("TOKENS");
		expect(r.out).toContain("WSUP1");
		expect(r.out).toContain("Q");
	});

	test("subagent lane never arms the loop", () => {
		const r = runHook(
			REPO_B,
			join(HOME, "nested", "subagents", "agent-x.jsonl"),
		);
		expect(r.out).toContain("SUBAGENT LANE");
		expect(r.out).not.toContain("SUPERVISOR DEFAULT");
		// W1069: a subagent is not a loop-arming runtime — neither face
		expect(r.out).not.toContain("SUPERVISOR CONTRACT");
	});
});
