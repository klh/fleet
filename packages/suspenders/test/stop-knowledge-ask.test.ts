// test/stop-knowledge-ask.test.ts — W1146: the W497 session-end knowledge ask
// is retired from the shared Stop gate. Live WS/CLI Stop is end-of-TURN, not
// session end — the ask re-prompted on ordinary answer boundaries once the
// transcript passed 20KB. Passive knowledge write-back rides the true
// SessionEnd settle (hooks/lib/settle.ts); completion checks are unchanged.
// Temp HOME + temp git repo; the REAL gate.ts stop in a bun subprocess
// (test/fleet.test.ts recipe, context-guard.test.ts fixture shape).
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpDir } from "./helpers/fixture-kit.ts";

import { join } from "node:path";

setDefaultTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

const root = tmpDir("suspenders-stop-ask-");
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home };
const GATE = join(import.meta.dir, "../hooks/gate.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

/** Substantive JSONL transcript > 20KB — assistant answer turns, no usage
 * objects (the W642 context guard stays out of the picture). */
function substantiveTranscript(): string {
	const body = Array.from(
		{ length: 48 },
		(_, i) =>
			`${JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `answer ${i}: ${"x".repeat(500)}` }],
				},
			})}\n`,
	).join("");
	const f = join(root, `tx-${process.pid}-${++sequence}.jsonl`);
	writeFileSync(f, body);
	return f;
}

function repo(): string {
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
	return cwd;
}

function stop(cwd: string, input: Record<string, unknown>) {
	const payload = join(root, "input.json");
	writeFileSync(payload, JSON.stringify(input));
	const p = Bun.spawnSync([process.execPath, GATE, "stop"], {
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

const learningsDir = (cwd: string) => join(cwd, ".fleet", "session-learnings");

describe("W1146: no knowledge ask on ordinary Stop", () => {
	test("repeated answer stops, stable live sid: zero re-prompts", () => {
		const cwd = repo();
		const tx = substantiveTranscript();
		for (let i = 0; i < 3; i++) {
			const s = stop(cwd, {
				cwd,
				session_id: "live-sess",
				transcript_path: tx,
				hook_event_name: "Stop",
			});
			expect(s.code).toBe(0);
			expect(s.err).not.toContain("Session-end knowledge ask");
			expect(s.out).toBe("{}");
			expect(existsSync(learningsDir(cwd))).toBeFalse();
		}
	});

	test("rotating per-turn hook ids: zero prompts, no marker dir", () => {
		const cwd = repo();
		const tx = substantiveTranscript();
		for (let i = 0; i < 6; i++) {
			const s = stop(cwd, {
				cwd,
				session_id: `turn-sess-${process.pid}-${i}`,
				transcript_path: tx,
				hook_event_name: "Stop",
			});
			expect(s.code).toBe(0);
			expect(s.err).not.toContain("Session-end knowledge ask");
			expect(existsSync(learningsDir(cwd))).toBeFalse();
		}
	});
});

test("completion gate unchanged: unmerged paths still block Stop", () => {
	const cwd = repo();
	const tx = substantiveTranscript();
	// f.ts on main + side with divergent edits, merged into a UU conflict —
	// the unmerged branch of the stop gate fires without a biome-configured
	// repo (temp fixtures have none, so the qlty syntax route exit-99 skips)
	const g = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	writeFileSync(join(cwd, "f.ts"), "base\n");
	g("add", "f.ts");
	g("commit", "-qm", "base2");
	g("checkout", "-q", "-b", "side");
	writeFileSync(join(cwd, "f.ts"), "side\n");
	g("commit", "-qam", "side");
	g("checkout", "-q", "main");
	writeFileSync(join(cwd, "f.ts"), "main\n");
	g("commit", "-qam", "main");
	g("merge", "side");
	const s = stop(cwd, {
		cwd,
		session_id: "live-sess-done",
		transcript_path: tx,
		hook_event_name: "Stop",
	});
	expect(s.code).toBe(2);
	expect(s.err).toContain("STOP-GATE");
	expect(s.err).toContain("unmerged: f.ts");
	expect(s.err).not.toContain("Session-end knowledge ask");
});
