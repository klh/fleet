// test/bash-hardening-gate.test.ts — W513 hardening through the REAL gate
// (bun hooks/gate.ts pre-bash), lane-identity fixtures per gates.test.ts.
// The gate collects write targets with REAL filesystem resolution — fixture
// dirs are created for real so containment/sensitive checks see them.
import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(process.cwd(), ".bashhard-gate-test-"));
test.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// real nested dir for the in-worktree allow case
mkdirSync(join(tmp, "pkg"), { recursive: true });

function spawnGate(command: string, cwd: string, env?: Record<string, string>) {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(
		pf,
		JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			cwd,
			session_id: "bashhard-gate-lane",
			transcript_path: "/nonexistent.jsonl",
		}),
	);
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "pre-bash"],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
			env: env ? { ...process.env, ...env } : undefined,
		},
	);
	rmSync(pf);
	let json: {
		hookSpecificOutput?: {
			permissionDecision?: string;
			permissionDecisionReason?: string;
		};
	} | null = null;
	try {
		json = JSON.parse(r.stdout.toString());
	} catch {}
	return { code: r.exitCode, json };
}
const decision = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
const reason = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";

// Lane identity: this TEST process is the registry ancestor (its real pid in
// the fixture lanes.json makes the spawned gate see a live lane). writeLanes
// swaps entries per test; `ghost` registry = the non-lane (owner) case.
const fleetDir = join(tmp, ".fleet");
const writeLanes = (entries: unknown[]) => {
	mkdirSync(fleetDir, { recursive: true });
	writeFileSync(join(fleetDir, "lanes.json"), JSON.stringify(entries));
};
const laneEntry = (pid: number) => [
	{
		sid: "autow513t",
		item: "W513T",
		pid,
		branch: "suspenders/W513T",
		worktree: tmp,
	},
];

test.describe("bash-hardening through the real gate", () => {
	test("lane: device redirect → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("echo x > /dev/sda", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("device redirect");
	});

	test("lane: write into .git/ → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("echo x > .git/hooks/pre-commit", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("governed Edit/Write");
	});

	test("lane: write into .env → deny; .env.example → allow", () => {
		writeLanes(laneEntry(process.pid));
		const r1 = spawnGate("echo X=1 > .env", tmp);
		expect(decision(r1)).toBe("deny");
		const r2 = spawnGate("echo X=1 > .env.example", tmp);
		expect(decision(r2)).toBe("allow");
	});

	test("lane: tee outside the worktree → containment deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("echo x | tee /etc/hosts", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("outside this lane's worktree");
	});

	test("lane: tee inside the worktree → allow", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("echo x | tee pkg/in.txt", tmp);
		expect(decision(r)).toBe("allow");
	});

	test("lane: replacement operands are data, actual target paths stay governed", () => {
		writeLanes(laneEntry(process.pid));
		for (const cmd of [
			"sd old /replacement pkg/in.txt",
			"sd -f i old .env pkg/in.txt",
			"sd -n 1 old /dev/disk0 pkg/in.txt",
			"ambr --max-threads 2 old /replacement pkg",
		])
			expect(decision(spawnGate(cmd, tmp))).toBe("allow");
		for (const cmd of [
			"sd old new /etc/hosts",
			"sd --flags i old new .env",
			"ambr old new /etc",
		])
			expect(decision(spawnGate(cmd, tmp))).toBe("deny");
	});

	test("lane: symlink escaping the worktree → containment deny", () => {
		writeLanes(laneEntry(process.pid));
		// real symlink: inside the worktree, pointing OUT
		const { symlinkSync } = require("node:fs");
		try {
			symlinkSync("/etc", join(tmp, "escape"));
		} catch {}
		const r = spawnGate("echo x > escape/out", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("outside this lane's worktree");
	});

	test("lane: git reset --hard → deny (W250 two-person: approvable, not hard-denied)", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("git reset --hard", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("two-person");
	});

	test("lane: git clean -fd → deny; -nd → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("git clean -fd", tmp))).toBe("deny");
		expect(decision(spawnGate("git clean -nd", tmp))).toBe("allow");
	});

	test("lane: git branch -D → deny; -d → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("git branch -D x", tmp))).toBe("deny");
		expect(decision(spawnGate("git branch -d x", tmp))).toBe("allow");
	});

	test("lane: git checkout . / restore . → deny", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("git checkout .", tmp))).toBe("deny");
		expect(decision(spawnGate("git restore -- .", tmp))).toBe("deny");
	});

	test("lane: nested sudo git push main → push-guard deny (the lift)", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("sudo -u root git push origin main", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("push-guard");
	});

	test("lane: sh -c git reset --hard → deny (nested unwrap)", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("sh -c 'git reset --hard'", tmp);
		expect(decision(r)).toBe("deny");
		// W250: the nested segment resolves in the two-person detector now
		expect(reason(r)).toContain("two-person");
	});

	test("non-lane: reset --hard/clean -f/checkout . → allow (owner free)", () => {
		writeLanes([
			{ sid: "ghost", item: "G", pid: 99999999, branch: "x", worktree: tmp },
		]);
		expect(decision(spawnGate("git reset --hard", tmp))).toBe("allow");
		expect(decision(spawnGate("git clean -fd", tmp))).toBe("allow");
		expect(decision(spawnGate("git checkout .", tmp))).toBe("allow");
		const owner = spawnGate("echo x > .git/hooks/x", tmp);
		expect(decision(owner)).toBe("allow");
		expect(
			String(owner.json?.hookSpecificOutput?.additionalContext ?? "").length,
		).toBeGreaterThan(0);
	});

	test("non-lane: /dev/sda still denied (catastrophic is for everyone)", () => {
		writeLanes([
			{ sid: "ghost", item: "G", pid: 99999999, branch: "x", worktree: tmp },
		]);
		const r = spawnGate("echo x > /dev/sda", tmp);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("device redirect");
	});

	test("everyone: plain work → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("echo hi", tmp))).toBe("allow");
		expect(decision(spawnGate("echo x > /dev/null", tmp))).toBe("allow");
		expect(
			decision(spawnGate("bun test test/gates.test.ts > /tmp/o", tmp)),
		).toBe("allow");
	});
});

// W266.2 plane-loop gate through the REAL gate: the narrow conjunction
// (outside-repo AND unbounded-loop AND plane-verb spawn) plus the logged
// plane-exempt escape. The outside fixture MUST live under os.tmpdir() —
// the default fixture above sits inside this repo, where the gate allows.
test.describe("W266.2 plane-loop gate", () => {
	const outside = mkdtempSync(join(realpathSync(tmpdir()), "plane-gate-out-"));
	test.afterAll(() => rmSync(outside, { recursive: true, force: true }));

	const writeExempt = (sids: string[]) => {
		mkdirSync(join(outside, ".cache/claude-governor"), { recursive: true });
		writeFileSync(
			join(outside, ".cache/claude-governor/plane-exempt.json"),
			JSON.stringify(sids),
		);
	};

	test("unbounded loop + coord outside any repo → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("while true; do coord ping; done", outside);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("plane-loop-gate");
	});

	test("until false + board, cd-tracked outside → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate(
			`cd ${outside} && until false; do board status; done`,
			tmp,
		);
		expect(decision(r)).toBe("deny");
	});

	test("sh -c nested payload → deny (gateSegments unwrap)", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate("bash -c 'while true; do coord ping; done'", outside);
		expect(decision(r)).toBe("deny");
	});

	test("bounded loop + coord → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(
			decision(spawnGate("for i in 1 2 3; do coord ping; done", outside)),
		).toBe("allow");
	});

	test("unbounded loop without a plane verb → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("while true; do echo hi; done", outside))).toBe(
			"allow",
		);
	});

	test("plane verb + unbounded loop INSIDE the repo → allow", () => {
		writeLanes(laneEntry(process.pid));
		expect(decision(spawnGate("while true; do coord ping; done", tmp))).toBe(
			"allow",
		);
	});

	test("plane-exempt sid escapes WITH a log line", () => {
		writeLanes(laneEntry(process.pid));
		writeExempt(["bashhard-gate-lane"]);
		const r = spawnGate(
			"while true; do fleet-loop once --repo .; done",
			outside,
			{ HOME: outside }, // exempt file + audit resolve in the fixture HOME
		);
		expect(decision(r)).toBe("allow");
		const lines = require("node:fs")
			.readFileSync(
				join(outside, ".cache/claude-governor/denied-calls.jsonl"),
				"utf8",
			)
			.trim()
			.split("\n");
		const last = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(last.tool).toBe("plane-exempt");
		expect(last.reason).toContain("fleet-loop");
		rmSync(join(outside, ".cache"), { recursive: true, force: true });
	});

	test("exempt file must name the sid — another sid still denies", () => {
		writeLanes(laneEntry(process.pid));
		writeExempt(["some-other-lane"]);
		const r = spawnGate("while true; do coord ping; done", outside, {
			HOME: outside,
		});
		expect(decision(r)).toBe("deny");
		rmSync(join(outside, ".cache"), { recursive: true, force: true });
	});
});
