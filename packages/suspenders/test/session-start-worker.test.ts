// session-start-worker.test.ts — W1124.12: a managed worker lane (the
// dispatch-written KLH_SESSION_ROLE=lane settings marker) is an executor,
// not a supervisor: session-start skips the SUPERVISOR DEFAULT refill
// directive + the W892 report injection while the coordination context
// (OWNED/READY/INBOX, RULES, GOVERNANCE, WS) stays live. Isolated temp HOME
// + repo, spawns the real hook.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-worker-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-worker-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env: Record<string, string | undefined> = {
	...process.env,
	HOME,
	// W834 role marker: dispatch writes it into the per-lane 0600 --settings
	// file; here the spawn env carries it for the harness.
	KLH_SESSION_ROLE: "lane",
};
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
env.SUSPENDERS_BUCKLE_FRONT = "http://127.0.0.1:1";
env.SUSPENDERS_BELT_ENV = join(HOME, "absent-belt.env");
const hook = join(import.meta.dir, "..", "hooks", "session-start.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const SID = "worker-sess-33333333";

function runHook() {
	const payload = join(
		HOME,
		`payload-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		payload,
		JSON.stringify({ session_id: SID, source: "startup", cwd: REPO }),
	);
	const p = Bun.spawnSync(["bun", hook], {
		cwd: REPO,
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

function seedReady(): void {
	const db = new Database(DB);
	db.run(
		"INSERT INTO work_items (project, id, title, state, priority, required, created_at, updated_at) VALUES (?, 'WWORK1', 'seed item', 'READY', 0, 1, ?, ?)",
		// projectIdentity = git common dir, else the realpath (fixture repo
		// is not a real git repo — the dir itself is the key).
		[realpathSync(REPO), Date.now(), Date.now()],
	);
	db.close();
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("worker-role lane bootstrap (W1124.12)", () => {
	test("registers as a top-level session and stays coordination-live", () => {
		const r = runHook();
		expect(r.code).toBe(0);
		expect(r.out).toContain(`SESSION ${SID.slice(0, 8)}`);
		expect(r.out).toContain("CURRENT COORDINATION");
		expect(r.out).toContain("coord subscribe");
	});

	test("READY pool present but no SUPERVISOR DEFAULT and no report table", () => {
		seedReady();
		const r = runHook();
		expect(r.code).toBe(0);
		expect(r.out).toContain("READY 1");
		expect(r.out).not.toContain("SUPERVISOR DEFAULT");
		expect(r.out).not.toContain("/loop refill");
		expect(r.out).not.toContain("ITEM");
	});
});
