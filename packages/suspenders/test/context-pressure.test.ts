// context-pressure.test.ts — W510: transcript-tail estimator, stop-gate
// pressure bands (once per session per band), PreCompact capsule flush, and
// compact-resume injection. Isolated temp HOME + repos; spawns the real
// hooks. Scratch lives under os.tmpdir(), never the package tree (W520).

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "w510-home-"));
const env = { ...process.env, HOME, GOVERNOR_STORE_URL: "" };
const HOOKS = join(import.meta.dir, "..", "hooks");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

let sequence = 0;
function repo(): string {
	const dir = join(HOME, `repo-${++sequence}`);
	mkdirSync(dir, { recursive: true });
	Bun.spawnSync(["git", "init", "-q"], {
		cwd: dir,
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.email", "t@t.invalid"], {
		cwd: dir,
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.name", "t"], {
		cwd: dir,
		stdout: "ignore",
		stderr: "ignore",
	});
	return dir;
}

// JSONL transcript fixture: `usage` rows in tokens, trailing noise rows.
function transcript(dir: string, tokens: number, extra?: string): string {
	const rows: string[] = [
		JSON.stringify({
			type: "user",
			message: { role: "user", content: "work" },
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				usage: {
					input_tokens: 500,
					cache_read_input_tokens: tokens - 500,
					cache_creation_input_tokens: 0,
				},
			},
		}),
		JSON.stringify({
			type: "attachment",
			attachment: { type: "hook_success" },
		}),
	];
	if (extra) rows.push(extra);
	const p = join(dir, "transcript.jsonl");
	writeFileSync(p, `${rows.join("\n")}\n`);
	return p;
}

function runHook(args: string[], input: unknown, cwd?: string) {
	const [file, ...rest] = args;
	const payload = join(HOME, `in-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(payload, JSON.stringify(input));
	const p = Bun.spawnSync([process.execPath, join(HOOKS, file), ...rest], {
		cwd: cwd ?? HOME,
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

describe("stop-gate pressure bands (spawned, hermetic HOME)", () => {
	const W = (tokens: number, extra?: string) => {
		const dir = repo();
		const tp = transcript(dir, tokens, extra);
		return (input: Record<string, unknown>) =>
			runHook(
				["gate.ts", "stop"],
				{
					cwd: dir,
					transcript_path: tp,
					...input,
				},
				dir,
			).err;
	};
	test("warn band blocks once, then stands down", () => {
		const stop = W(150_000); // 75%
		expect(stop({ session_id: "sp-1" })).toContain("CONTEXT PRESSURE ~75%");
		expect(stop({ session_id: "sp-1" })).toBe("");
	});
	test("critical band blocks with the compact directive", () => {
		const stop = W(180_000); // 90%
		expect(stop({ session_id: "sp-2" })).toContain("/compact");
	});
	test("continuations, aborts, and the 95% floor never block", () => {
		const stop = W(150_000);
		expect(stop({ session_id: "sp-3", stop_hook_active: true })).toBe("");
		const intr = "Request interrupted by user";
		expect(
			stop({
				session_id: "sp-4",
				transcript_path: transcript(
					repo(),
					150_000,
					JSON.stringify({ type: "user", message: { content: intr } }),
				),
			}),
		).toBe("");
		expect(
			stop({
				session_id: "sp-5",
				transcript_path: transcript(repo(), 198_000),
			}),
		).toBe("");
	});
});

describe("PreCompact flush", () => {
	test("banks the lane capsule via the coord CLI", () => {
		const dir = repo();
		mkdirSync(join(dir, ".fleet"), { recursive: true });
		writeFileSync(
			join(dir, ".fleet/lane-context.json"),
			JSON.stringify({ sid: "lane-w510-test", item: "W1", launchedAt: 1 }),
		);
		const g = (...a: string[]) =>
			Bun.spawnSync(["git", "-C", dir, ...a], {
				stdout: "pipe",
				stderr: "pipe",
			});
		g("init", "-q");
		g("config", "user.email", "t@t.invalid");
		g("config", "user.name", "t");
		writeFileSync(join(dir, "f.ts"), "export const a = 1;\n");
		g("add", ".");
		g("commit", "-qm", "base");
		writeFileSync(join(dir, "f.ts"), "export const a = 2;\n");
		const r = runHook(["gate.ts", "pre-compact"], { cwd: dir }, dir);
		expect(r.code).toBe(0);
		const row = new Database(join(HOME, ".cache/claude-governor/governor.db"), {
			readonly: true,
		})
			.query("SELECT value FROM facts WHERE key = ?")
			.get("lane.lane-w510-test.capsule") as { value: string } | null;
		const cap = JSON.parse(row?.value ?? "{}") as Record<string, string>;
		expect(cap.checkpoint).toMatch(/^[0-9a-f]{40}$/);
		expect(cap.item).toBe("W1");
		expect(cap.files).toBe("f.ts");
		expect(cap.note).toBe("pre-compact auto-bank");
	});
});

describe("compact-resume injection", () => {
	test("source=compact injects the banked lane capsule", () => {
		const dir = repo();
		mkdirSync(join(dir, ".fleet"), { recursive: true });
		writeFileSync(
			join(dir, ".fleet/lane-context.json"),
			JSON.stringify({ sid: "lane-w510-test", item: "W1", launchedAt: 1 }),
		);
		const r = runHook(
			["session-start.ts"],
			{ session_id: "ss-1", source: "compact", cwd: dir },
			dir,
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("PRE-COMPACT CAPSULE W1");
		expect(r.out).toContain("lane-w510-test");
	});
});
