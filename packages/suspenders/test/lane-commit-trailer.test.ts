// test/lane-commit-trailer.test.ts — W1141: the PreToolUse trailer-injection
// hook. Pure-surface tests: the commit rewrite, the identity fallback, the
// PreToolUse output shape, and the fail-open contract (exit 0, silent).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitTrailerOutput,
	commitWithTrailers,
	laneIdentityFromContext,
} from "../hooks/bin/lane-commit-trailer.ts";

describe("commitWithTrailers (the rewrite)", () => {
	const SID = "autow1141-p98b319584008df14";

	test("appends quoted Fleet-Session/Fleet-Item flags to a -m commit", () => {
		const out = commitWithTrailers('git commit -m "fix"', SID, "W1141");
		expect(out).toContain('-m "fix"');
		expect(out).toContain(
			"'--trailer' 'Fleet-Session=autow1141-p98b319584008df14'",
		);
		expect(out).toContain("'Fleet-Item=W1141'");
	});

	test("other subcommands and trailer/amend-carrying calls stay untouched", () => {
		expect(commitWithTrailers("git push origin HEAD", SID, "W1141")).toBeNull();
		expect(
			commitWithTrailers("git commit --amend -m x", SID, "历史"),
		).toBeNull();
		expect(
			commitWithTrailers('git commit -m x --trailer "A=b"', SID, "W1141"),
		).toBeNull();
	});
});

describe("laneIdentityFromContext (dispatch-written activation context)", () => {
	test("reads sid/item from .fleet/lane-context.json; null on absent/bad", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1141-ctx-"));
		const ctx = join(dir, ".fleet", "lane-context.json");
		mkdirSync(join(dir, ".fleet"), { recursive: true });
		writeFileSync(ctx, JSON.stringify({ sid: "autow1", item: "W1" }));
		expect(laneIdentityFromContext(dir)).toEqual({ sid: "autow1", item: "W1" });
		writeFileSync(ctx, "{nope");
		expect(laneIdentityFromContext(dir)).toBeNull();
		writeFileSync(ctx, JSON.stringify({ sid: 7 }));
		expect(laneIdentityFromContext(dir)).toBeNull();
		expect(laneIdentityFromContext(join(dir, "nope"))).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("commitTrailerOutput (PreToolUse shape)", () => {
	const SID = "autow1141-p98b319584008df14";

	test("Bash git-commit gets updatedInput; other tools/calls stay untouched", () => {
		const out = commitTrailerOutput(
			"Bash",
			{ command: "git commit -m x", cwd: "/r" },
			SID,
			"W1141",
		);
		expect(out).not.toBeNull();
		const h = (out as Record<string, unknown>).hookSpecificOutput as Record<
			string,
			unknown
		>;
		expect(h.hookEventName).toBe("PreToolUse");
		const ui = h.updatedInput as { command: string; cwd?: string };
		expect(ui.command).toContain("Fleet-Item=W1141");
		expect(ui.cwd).toBe("/r");
		expect(
			commitTrailerOutput("Task", { command: "git commit -m x" }, SID, "W1141"),
		).toBeNull();
		expect(commitTrailerOutput("Bash", { nope: 1 }, SID, "W1141")).toBeNull();
	});
});

describe("main handler (end-to-end, spawned)", () => {
	const HOOK = join(
		import.meta.dir,
		"..",
		"hooks",
		"bin",
		"lane-commit-trailer.ts",
	);

	test("rewrites a Bash commit payload via --sid/--item", async () => {
		const p = Bun.spawn(
			[process.execPath, HOOK, "--sid", "s", "--item", "W1141"],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			},
		);
		p.stdin.write(
			JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "git commit -m x" },
			}),
		);
		p.stdin.end();
		const out = await new Response(p.stdout).text();
		await p.exited;
		const parsed = JSON.parse(out) as {
			hookSpecificOutput: { updatedInput: { command: string } };
		};
		expect(parsed.hookSpecificOutput.updatedInput.command).toContain(
			"Fleet-Session=s",
		);
	});

	test("fails open: no identity → exit 0, silent", () => {
		const p = Bun.spawnSync([process.execPath, HOOK], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		expect(p.exitCode).toBe(0);
		expect(p.stdout.toString()).toBe("");
	});
});
