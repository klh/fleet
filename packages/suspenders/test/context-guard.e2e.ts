import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-ctxguard-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home };
test.afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

const usageLine = (tokens: number) =>
	`{"type":"assistant","message":{"id":"msg","usage":{"input_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":${tokens},"output_tokens":1}}}\n`;

function fixture(transcriptBody: string) {
	const cwd = join(root, `repo-${++sequence}`);
	mkdirSync(cwd);
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(cwd, "README.md"), "base\n");
	Bun.spawnSync(["git", "add", "README.md"], { cwd, stdout: "pipe" });
	Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd, stdout: "pipe" });
	// transcript under the fixture HOME's projects dir (cwd encoding)
	const projDir = join(
		home,
		".claude/projects",
		cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
	);
	mkdirSync(projDir, { recursive: true });
	const transcript = join(projDir, `sess-${process.pid}-${sequence}.jsonl`);
	writeFileSync(transcript, transcriptBody);
	return { cwd, sid: `sess-${process.pid}-${sequence}`, transcript };
}

function stop(cwd: string, input: Record<string, unknown>) {
	const payload = join(root, "input.json");
	writeFileSync(payload, JSON.stringify(input));
	const p = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../hooks/gate.ts"), "stop"],
		{
			cwd,
			env,
			stdin: Bun.file(payload),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

test(">=75% blocks once with a checkpoint directive, capped at 2/session", () => {
	const f = fixture(usageLine(155_000)); // ~77.5% of 200k
	const base = { cwd: f.cwd, session_id: f.sid, transcript_path: f.transcript };
	const s1 = stop(f.cwd, base);
	expect(s1.code).toBe(2);
	expect(s1.err).toContain("CONTEXT PRESSURE");
	expect(s1.err).toContain("capsule");
	const s2 = stop(f.cwd, base);
	expect(s2.code).toBe(2);
	const s3 = stop(f.cwd, base);
	expect(s3.code).toBe(0);
	expect(s3.out).toBe("{}");
});

test(">=95% stands down even on the first crossing", () => {
	const f = fixture(usageLine(198_000)); // 99%
	expect(
		stop(f.cwd, {
			cwd: f.cwd,
			session_id: f.sid,
			transcript_path: f.transcript,
		}).code,
	).toBe(0);
});

test("abort and limit stops are never blocked", () => {
	const aborted = fixture(
		`${usageLine(155_000)}{"type":"user","message":{"role":"user","content":"[Request interrupted by user for tool use]"}}\n`,
	);
	expect(
		stop(aborted.cwd, {
			cwd: aborted.cwd,
			session_id: aborted.sid,
			transcript_path: aborted.transcript,
		}).code,
	).toBe(0);
	const limited = fixture(
		`${usageLine(155_000)}{"type":"system","message":"API Error: This request would exceed the usage limit","isApiErrorMessage":true}\n`,
	);
	expect(
		stop(limited.cwd, {
			cwd: limited.cwd,
			session_id: limited.sid,
			transcript_path: limited.transcript,
		}).code,
	).toBe(0);
});

test("below the guard threshold never fires", () => {
	const f = fixture(usageLine(40_000)); // 20%
	expect(
		stop(f.cwd, {
			cwd: f.cwd,
			session_id: f.sid,
			transcript_path: f.transcript,
		}).code,
	).toBe(0);
});

test("native used_percentage drives the reading without a transcript", () => {
	const f = fixture("");
	const s = stop(f.cwd, {
		cwd: f.cwd,
		session_id: f.sid,
		context_window: { used_percentage: 80, context_window_size: 200_000 },
	});
	expect(s.code).toBe(2);
	expect(s.err).toContain("CONTEXT PRESSURE 80%");
});

test("a different session id gets its own block budget", () => {
	const f = fixture(usageLine(155_000));
	const s = stop(f.cwd, {
		cwd: f.cwd,
		session_id: `other-sess-${process.pid}-1`,
		transcript_path: f.transcript,
	});
	expect(s.code).toBe(2);
});
