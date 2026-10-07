// test/session-end-async.test.ts — W514 (claudecode research §1.8): the
// session-end hook never hangs teardown — the stdin read is raced against
// 1 s, and the wiring example marks SessionEnd async:true. The full
// sid→CLOSED round-trip stays covered by w159-settle; this file pins the
// timeout mechanics and the wiring shape.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-sessend-"));
const END = join(import.meta.dir, "..", "hooks", "session-end.ts");

function spawnEnd(stdinFile: string): {
	code: number | null;
	ms: number;
} {
	const t0 = Date.now();
	const p = Bun.spawnSync(["bun", END], {
		cwd: TMP,
		env: { ...process.env, HOME: TMP },
		stdin: Bun.file(stdinFile),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode, ms: Date.now() - t0 };
}

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("session-end async hardening", () => {
	test("stdin never closed → 1s race resolves, exit clean", async () => {
		// async spawn with stdin held open: spawnSync cannot hold a pipe
		const t0 = Date.now();
		const proc = Bun.spawn(["bun", END], {
			cwd: TMP,
			env: { ...process.env, HOME: TMP },
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		}); // deliberately never write or end stdin
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // ~1s race, not a hang
		expect(Date.now() - t0).toBeLessThan(3_000);
	});

	test("payload without session_id exits fast and clean", () => {
		const pf = join(TMP, "nosid.json");
		writeFileSync(pf, JSON.stringify({ hook_event_name: "SessionEnd" }));
		const r = spawnEnd(pf);
		expect(r.code).toBe(0);
		expect(r.ms).toBeLessThan(1_000);
	});

	test("malformed payload exits clean (no throw)", () => {
		const pf = join(TMP, "junk.json");
		writeFileSync(pf, "not json at all");
		const r = spawnEnd(pf);
		expect(r.code).toBe(0);
	});

	test("settings.example.json marks SessionEnd async:true", () => {
		const s = JSON.parse(
			readFileSync(
				join(import.meta.dir, "..", "settings.example.json"),
				"utf8",
			),
		) as {
			hooks: Record<
				string,
				Array<{ hooks: Array<{ command: string; async?: boolean }> }>
			>;
		};
		const entry = s.hooks.SessionEnd[0].hooks.find((h) =>
			h.command.includes("session-end.ts"),
		);
		expect(entry?.async).toBe(true);
	});
});
