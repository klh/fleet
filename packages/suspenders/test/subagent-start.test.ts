import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_ITEMS } from "../hooks/lib/harness-manifest.ts";
import { hookLaneId, hookSubagentSuffix } from "../hooks/lib/hook-lane.ts";
import { reapSubscribe } from "../hooks/lib/subscribe-attach.ts";

const home = mkdtempSync(join(tmpdir(), "native-child-home-"));
const repo = mkdtempSync(join(tmpdir(), "native-child-repo-"));
const hooks = join(import.meta.dir, "../hooks");
const parent = `wtest-native-${Date.now()}`;
const env = { ...process.env, HOME: home };
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
const transcript = join(home, `${parent}.jsonl`);
const dbPath = join(home, ".cache/claude-governor/governor.db");
const git = Bun.spawnSync(["git", "init", "-q", repo]);
expect(git.exitCode).toBe(0);
const bootstrap = Bun.spawnSync(
	["bun", join(hooks, "bin/coord.ts"), "bootstrap", "--as", parent],
	{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
);
expect(bootstrap.exitCode).toBe(0);
let payloadIndex = 0;

afterAll(() => {
	for (const agent of ["a1", "b2"]) reapSubscribe(`${parent}#agent-${agent}`);
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const nativeHook = (agent: string) => ({
	session_id: parent,
	transcript_path: transcript,
	cwd: repo,
	hook_event_name: "SubagentStart",
	agent_id: agent,
	agent_type: "claude",
});

function start(input: Record<string, unknown>) {
	const payload = join(home, `payload-${payloadIndex++}.json`);
	writeFileSync(payload, JSON.stringify(input));
	const proc = Bun.spawnSync(["bun", join(hooks, "subagent-start.ts")], {
		cwd: repo,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

test("explicit native agent IDs agree with legacy transcript identities", () => {
	const expected = `${parent}#agent-a1`;
	expect(hookLaneId(nativeHook("a1"))).toBe(expected);
	expect(hookLaneId(nativeHook("agent-a1"))).toBe(expected);
	expect(
		hookLaneId({
			session_id: parent,
			transcript_path: join(home, parent, "subagents/agent-a1.jsonl"),
		}),
	).toBe(expected);
	expect(hookLaneId({ ...nativeHook("a1"), session_id: expected })).toBe(
		expected,
	);
	expect(
		hookSubagentSuffix({ session_id: parent, agent_type: "custom-primary" }),
	).toBe("");
	expect(hookLaneId({ session_id: parent })).toBe(parent);
});

test("SubagentStart registers and injects a child identity without changing its parent", () => {
	const db = new Database(dbPath);
	try {
		const before = db.query("SELECT * FROM sessions WHERE sid=?").get(parent);
		const result = start(nativeHook("a1"));
		expect(result.code).toBe(0);
		expect(result.err).toBe("");
		const output = JSON.parse(result.out).hookSpecificOutput;
		expect(output.hookEventName).toBe("SubagentStart");
		expect(output.additionalContext).toContain(`--as ${parent}#agent-a1`);
		expect(
			db
				.query(
					"SELECT sid,parent_sid,project,role,transcript_path,worktree FROM sessions WHERE sid=?",
				)
				.get(`${parent}#agent-a1`),
		).toEqual({
			sid: `${parent}#agent-a1`,
			parent_sid: parent,
			project: realpathSync(join(repo, ".git")),
			role: "worker",
			worktree: null,
			transcript_path: join(home, parent, "subagents/agent-a1.jsonl"),
		});
		expect(db.query("SELECT * FROM sessions WHERE sid=?").get(parent)).toEqual(
			before,
		);
	} finally {
		db.close();
	}
});

test("a repeated start preserves the child's claimed worktree and keeps siblings separate", () => {
	const db = new Database(dbPath);
	try {
		const sid = `${parent}#agent-a1`;
		const tree = join(repo, ".worktrees/W1");
		db.query("UPDATE sessions SET worktree=? WHERE sid=?").run(tree, sid);
		expect(start(nativeHook("agent-a1")).code).toBe(0);
		expect(start(nativeHook("b2")).code).toBe(0);
		expect(
			db.query("SELECT worktree FROM sessions WHERE sid=?").get(sid),
		).toEqual({ worktree: tree });
		expect(
			db
				.query("SELECT sid FROM sessions WHERE parent_sid=? ORDER BY sid")
				.all(parent),
		).toEqual([{ sid }, { sid: `${parent}#agent-b2` }]);
	} finally {
		db.close();
	}
});

test("an event without a native child identity leaves session registration alone", () => {
	expect(start({ session_id: parent, cwd: repo }).out).toBe("{}");
});

test("the shipped settings and installed harness publish SubagentStart", () => {
	const settings = JSON.parse(
		readFileSync(join(import.meta.dir, "../settings.example.json"), "utf8"),
	);
	expect(settings.hooks.SubagentStart?.[0]?.hooks?.[0]?.command).toContain(
		"/subagent-start.ts",
	);
	expect(HOOK_ITEMS).toContain("subagent-start.ts");
});
