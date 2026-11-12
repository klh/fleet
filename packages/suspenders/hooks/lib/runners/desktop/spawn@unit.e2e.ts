import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { runArgv, boundedBinaryRunner } from "./spawn.ts";

const ignoresTerm =
	'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => process.exit(0), 1100);';

test("runArgv timeout hard-kills and joins an owned HOST child ignoring SIGTERM @unit", async () => {
	const start = performance.now();
	const result = await runArgv([process.execPath, "-e", ignoresTerm], {
		timeoutMs: 100,
	});
	expect(result.stdout).toContain("ready");
	expect(performance.now() - start).toBeLessThan(700);
	expect(result.code).not.toBe(0);
});

test("runArgv output overflow hard-kills and joins an owned HOST child ignoring SIGTERM @unit", async () => {
	const start = performance.now();
	const result = await runArgv(
		[
			process.execPath,
			"-e",
			`${ignoresTerm}process.stdout.write("x".repeat(32768));`,
		],
		{ timeoutMs: 2000, maxBytes: 16 },
	);
	expect(performance.now() - start).toBeLessThan(700);
	expect(result.code).not.toBe(0);
	expect(result.stdout).toContain("pipe truncated at 16 bytes");
});

for (const [label, run] of [
	["runArgv", runArgv],
	["boundedBinaryRunner", boundedBinaryRunner(2000)],
] as const)
	test(
		label +
			" abort hard-kills and joins an owned HOST child ignoring SIGTERM @unit",
		async () => {
			const controller = new AbortController(),
				start = performance.now();
			const timer = setTimeout(() => controller.abort(), 100);
			try {
				const result = await run([process.execPath, "-e", ignoresTerm], {
					timeoutMs: 2000,
					signal: controller.signal,
				});
				expect(result.stdout).toContain("ready");
				expect(performance.now() - start).toBeLessThan(700);
				expect(result.code).not.toBe(0);
			} finally {
				clearTimeout(timer);
			}
		},
	);

test("runArgv pre-abort refuses before spawning an owned HOST child @unit", async () => {
	const world = scratchWorld(),
		marker = join(world.home, "spawned");
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(
			runArgv(
				[
					process.execPath,
					"-e",
					`await Bun.write(${JSON.stringify(marker)}, "spawned");`,
				],
				{ signal: controller.signal },
			),
		).rejects.toThrow();
		expect(existsSync(marker)).toBe(false);
	} finally {
		world.clean();
	}
});

test("runArgv preserves normal UTF-8 stdin and drains both complete outputs @unit", async () => {
	const result = await runArgv(
		[
			process.execPath,
			"-e",
			'const input = await Bun.stdin.text(); process.stdout.write([input, "x".repeat(4096), "OUT-END"].join("")); process.stderr.write(["y".repeat(4096), "ERR-END"].join(""));',
		],
		{ stdin: "fixture-β\n", timeoutMs: 1000, maxBytes: 8192 },
	);
	expect(result).toEqual({
		code: 0,
		stdout: `fixture-β\n${"x".repeat(4096)}OUT-END`,
		stderr: `${"y".repeat(4096)}ERR-END`,
	});
});
