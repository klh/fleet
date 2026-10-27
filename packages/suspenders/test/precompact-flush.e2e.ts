// precompact-flush.test.ts — W642: the PreCompact gate writes
// .fleet/state-<sid>.md (claim + git progress + capsule done/next) before
// compaction, and the SessionStart bootstrap re-injects it when
// source=compact. Isolated temp HOME + repos; spawns the real hook/gate.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-precompact-"));
const home = join(root, "home");
mkdirSync(home);
// harness lane identity must not leak into spawned hooks (refused-session
// exit 1) — same stripping as session-start-supervisor.test.ts
const env: Record<string, string | undefined> = { ...process.env, HOME: home };
delete env.SUSPENDERS_SID;
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
test.afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const gate = join(import.meta.dir, "../hooks/gate.ts");
const sessionStart = join(import.meta.dir, "../hooks/session-start.ts");

function fixture() {
	const cwd = join(root, `repo-${++sequence}`);
	mkdirSync(cwd);
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.stdout.toString().trim();
	};
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(cwd, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-qm", "base");
	const work = (...args: string[]) => {
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../hooks/bin/work.ts"),
				...args,
			],
			{ cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const id = work("add", "precompact test").out.match(/W\d+/)?.[0] ?? "";
	work("take", id, "--as", "flush-lane");
	mkdirSync(join(cwd, ".fleet"));
	writeFileSync(
		join(cwd, ".fleet/lane-context.json"),
		JSON.stringify({
			sid: "flush-lane",
			item: id,
			baseline: git("rev-parse", "HEAD"),
			launchedAt: 42,
		}),
	);
	const projDir = join(
		home,
		".claude/projects",
		cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
	);
	mkdirSync(projDir, { recursive: true });
	const transcript = join(projDir, "flush.jsonl");
	const lines = [
		'{"type":"user","message":{"role":"user","content":"fix the flaky export test first"}}',
		'{"type":"assistant","message":{"role":"assistant","content":"working on it","usage":{"input_tokens":10}}}',
	];
	writeFileSync(transcript, `${lines.join("\n")}\n`);
	return { cwd, work, id, transcript };
}

function runGate(cwd: string, extra: Record<string, unknown> = {}) {
	const payload = join(root, `gate-input-${sequence}.json`);
	writeFileSync(
		payload,
		JSON.stringify({ cwd, session_id: "flush-lane", ...extra }),
	);
	const p = Bun.spawnSync([process.execPath, gate, "precompact"], {
		cwd,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

test("precompact flushes claim, git progress and capsule to .fleet/state-<sid>.md", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "x.txt"), "progress\n");
	Bun.spawnSync(["git", "add", "x.txt"], { cwd: f.cwd, stdout: "pipe" });
	Bun.spawnSync(["git", "commit", "-qm", "progress"], {
		cwd: f.cwd,
		stdout: "pipe",
	});
	const coord = (...args: string[]) => {
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../hooks/bin/coord.ts"),
				...args,
			],
			{ cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		return { code: p.exitCode, out: p.stdout.toString() };
	};
	const coordSet = coord(
		"capsule",
		"set",
		"--as",
		"flush-lane",
		"--item",
		f.id,
		`--checkpoint=${Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: f.cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()}`,
		"--done=export test isolated",
		"--next=fix remaining importer",
	);
	expect(coordSet.code).toBe(0);
	const r = runGate(f.cwd, { transcript_path: f.transcript });
	expect(r.code).toBe(0);
	const stateFile = join(f.cwd, ".fleet/state-flush-lane.md");
	expect(existsSync(stateFile)).toBe(true);
	const bodyText = readFileSync(stateFile, "utf8");
	expect(bodyText).toContain("## claim");
	expect(bodyText).toContain(f.id);
	expect(bodyText).toContain("[CLAIMED]");
	expect(bodyText).toContain("## progress (git)");
	expect(bodyText).toContain("done: export test isolated");
	expect(bodyText).toContain("next: fix remaining importer");
	expect(bodyText).toContain("fix the flaky export test first");
	expect(r.out).toContain("PRECOMPACT FLUSH");
});

test("no lane context still flushes under the hook session id", () => {
	const f = fixture();
	rmSync(join(f.cwd, ".fleet/lane-context.json"));
	const r = runGate(f.cwd);
	expect(r.code).toBe(0);
	expect(existsSync(join(f.cwd, ".fleet/state-flush-lane.md"))).toBe(true);
});

test("bootstrap re-injects the state file on a compact SessionStart", () => {
	const f = fixture();
	writeFileSync(
		join(f.cwd, ".fleet/state-flush-lane.md"),
		"# lane state — flush-lane\nresumption payload\n",
	);
	const payload = join(root, `ss-input-${sequence}.json`);
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: "flush-lane",
			source: "compact",
			cwd: f.cwd,
			transcript_path: f.transcript,
		}),
	);
	const p = Bun.spawnSync(["bun", sessionStart], {
		cwd: f.cwd,
		env: {
			...env,
			SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
			SUSPENDERS_BELT_ENV: join(home, "absent-belt.env"),
		},
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(p.exitCode).toBe(0);
	expect(p.stdout.toString()).toContain("PRECOMPACT STATE");
	expect(p.stdout.toString()).toContain("resumption payload");
});

test("startup source does not re-inject (compact-only surface)", () => {
	const f = fixture();
	writeFileSync(
		join(f.cwd, ".fleet/state-flush-lane.md"),
		"# lane state — flush-lane\nresumption payload\n",
	);
	const payload = join(root, `ss-input-${sequence}.json`);
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: "flush-lane",
			source: "startup",
			cwd: f.cwd,
			transcript_path: f.transcript,
		}),
	);
	const p = Bun.spawnSync(["bun", sessionStart], {
		cwd: f.cwd,
		env: {
			...env,
			SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
			SUSPENDERS_BELT_ENV: join(home, "absent-belt.env"),
		},
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(p.exitCode).toBe(0);
	expect(p.stdout.toString()).not.toContain("PRECOMPACT STATE");
});
