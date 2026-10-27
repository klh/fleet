import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeProjectDir,
	resolveTranscriptPath,
	transcriptTail,
} from "../hooks/lib/transcript.ts";

const root = mkdtempSync2();

function mkdtempSync2(): string {
	return join(tmpdir(), `fleet-transcript-${process.pid}-${Date.now()}`);
}

function command(cwd: string, args: string[]): { ok: boolean } {
	const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	return { ok: p.exitCode === 0 };
}

test("encodeProjectDir matches Claude Code's non-alnum → dash encoding", () => {
	expect(encodeProjectDir("/Volumes/Sensitive/github/klh/fleet")).toBe(
		"-Volumes-Sensitive-github-klh-fleet",
	);
	expect(encodeProjectDir("/repo/.claude/worktrees/wombat")).toBe(
		"-repo--claude-worktrees-wombat",
	);
});

const PROJECTS = (h: string) => join(h, ".claude/projects");

test("an existing transcript_path passes through untouched", () => {
	const home = join(root, "pass-home");
	const proj = join(PROJECTS(home), "-repo-main");
	mkdirSync(proj, { recursive: true });
	const t = join(proj, "sid-1.jsonl");
	writeFileSync(t, '{"type":"user"}\n');
	expect(
		resolveTranscriptPath(
			{ transcript_path: t, session_id: "sid-1", cwd: root },
			PROJECTS(home),
		),
	).toBe(t);
});

test("a registered Copilot events path resolves without substituting the Fleet SID", () => {
	const home = join(root, "copilot-home");
	const native = "c47f0616-d45f-4ab0-9fa4-32853c568b25";
	const directory = join(home, ".copilot/session-state", native);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "events.jsonl");
	writeFileSync(path, '{"type":"session.start"}\n');
	expect(
		resolveTranscriptPath(
			{
				transcript_path: path,
				session_id: "custom-fleet-sid",
			},
			PROJECTS(home),
		),
	).toBe(path);
	expect(
		resolveTranscriptPath(
			{
				session_id: "unregistered-fleet-sid",
			},
			PROJECTS(home),
		),
	).toBeNull();
});

test("a missing worktree transcript resolves via the main repo's encoded dir", () => {
	const home = join(root, "wt-home");
	const main = join(home, "repo");
	mkdirSync(main, { recursive: true });
	command(main, ["git", "init", "-q"]);
	command(main, ["git", "config", "user.email", "t@t.invalid"]);
	command(main, ["git", "config", "user.name", "t"]);
	writeFileSync(join(main, "f.txt"), "x\n");
	command(main, ["git", "add", "f.txt"]);
	command(main, ["git", "commit", "-qm", "base"]);
	// a REAL linked worktree: its git-common-dir points at the main .git
	const wt = join(main, ".worktrees/W9");
	command(main, ["git", "worktree", "add", "-q", wt, "-b", "wtb"]);
	// transcript exists ONLY under the MAIN repo's encoded projects dir —
	// encoded from git's REALPATH form (macOS tmp symlinks /var→/private/var,
	// and git reports the real path; production homes have no such symlink)
	const mainDir = join(
		home,
		".claude/projects",
		encodeProjectDir(realpathSync(main)),
	);
	mkdirSync(mainDir, { recursive: true });
	writeFileSync(join(mainDir, "sid-wt.jsonl"), '{"type":"user"}\n');
	const missingPath = join(
		home,
		".claude/projects",
		encodeProjectDir(wt),
		"sid-wt.jsonl",
	);
	expect(
		resolveTranscriptPath(
			{
				transcript_path: missingPath,
				session_id: "sid-wt",
				cwd: wt,
			},
			PROJECTS(home),
		),
	).toBe(join(mainDir, "sid-wt.jsonl"));
});

test("the --claude-worktrees-<name> strip finds the main-encoded transcript", () => {
	const home = join(root, "strip-home");
	const projects = PROJECTS(home);
	// hook path names the worktree-encoded dir (absent); only the STRIPPED
	// dir holds the file — the OMC #1094 fix
	const encodedWt = join(projects, "-repo--claude-worktrees-wombat");
	const strippedDir = join(projects, "-repo");
	mkdirSync(strippedDir, { recursive: true });
	writeFileSync(join(strippedDir, "sid-cc.jsonl"), "x\n");
	expect(
		resolveTranscriptPath(
			{
				transcript_path: join(encodedWt, "sid-cc.jsonl"),
				session_id: "sid-cc",
			},
			projects,
		),
	).toBe(join(strippedDir, "sid-cc.jsonl"));
});

test("a Codex rollout resolves by the exact session ID", () => {
	const home = join(root, "codex-home");
	const sessions = join(home, ".codex/sessions/2026/10/19");
	mkdirSync(sessions, { recursive: true });
	const sid = "01a152cf-82a0-7a93-8730-9256694cfa67";
	const rollout = join(sessions, `rollout-2026-10-19T08-18-13-${sid}.jsonl`);
	writeFileSync(rollout, '{"type":"session_meta"}\n');
	expect(
		resolveTranscriptPath({ session_id: sid, cwd: root }, PROJECTS(home)),
	).toBe(rollout);
	expect(
		resolveTranscriptPath(
			{ session_id: "../../../other", cwd: root },
			PROJECTS(home),
		),
	).toBeNull();
});

test("no candidate resolves to null (fail open)", () => {
	expect(
		resolveTranscriptPath(
			{
				transcript_path: "/nonexistent/nope.jsonl",
				session_id: "sid-none",
				cwd: root,
			},
			PROJECTS(join(root, "empty-home")),
		),
	).toBeNull();
});

test("transcriptTail reads the bounded end of a file", () => {
	const p = join(root, "tail.jsonl");
	writeFileSync(p, `${"a".repeat(5000)}\n{"usage":{"input_tokens":4}}\n`);
	const tail = transcriptTail(p, 64);
	expect(tail.length).toBe(64);
	expect(tail).toContain('"input_tokens":4');
});
