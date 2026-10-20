// session-start-supervisor.test.ts — W637: the SessionStart hook renders the
// supervisor-default arm-loop directive when the project's READY pool holds
// work (compliance by injection, not model-recall). Top-level sessions only —
// a subagent lane is not a loop-arming runtime. Isolated temp HOME + repos,
// spawns the real hook.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { projectIdentity } from "../hooks/lib/govdb.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-sup-"));
const REPO_A = mkdtempSync(join(tmpdir(), "suspenders-sup-repo-a-"));
const REPO_B = mkdtempSync(join(tmpdir(), "suspenders-sup-repo-b-"));
mkdirSync(join(REPO_B, ".git"), { recursive: true });
// harness lane identity must not leak into the spawned hook: a live
// SUSPENDERS_SID + canonical-v1 protocol trips the declared-lane gate for
// the test's own sid, and a real front + belt.env would mint real keys
const env: Record<string, string | undefined> = { ...process.env, HOME };
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
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

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO_A, { recursive: true, force: true });
	rmSync(REPO_B, { recursive: true, force: true });
});

describe("supervisor-default directive (W637)", () => {
	test("no READY work — no directive", () => {
		const r = runHook(REPO_A, join(HOME, "tp-a.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("SUPERVISOR DEFAULT");
	});

	test("top-level start with READY>0 renders the arm-loop directive", () => {
		const first = runHook(REPO_B, join(HOME, "tp-b.jsonl"));
		expect(first.code).toBe(0);
		seedReady(PROJECT_B);
		const r = runHook(REPO_B, join(HOME, "tp-b.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("SUPERVISOR DEFAULT");
		expect(r.out).toContain("/loop refill");
		expect(r.out).toContain("READY 1");
		expect(r.out).toContain("coord message <sid>");
		expect(r.out).toContain("never cancel the lane just to revise its prompt");
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
	});
});
