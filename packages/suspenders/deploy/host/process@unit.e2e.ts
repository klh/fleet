import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { mkdir, symlink } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { hostProcess } from "./process.ts";

test("HOST primitive returns exact UTF8, stderr, nonzero and joins normal completion @unit", async () => {
	const result = await hostProcess(
		[
			process.execPath,
			"-e",
			"process.stdout.write('ÆØÅ');process.stderr.write('diagnostic');process.exit(7)",
		],
		{ timeoutMs: 2000 },
	);
	expect(result.code).toBe(7);
	expect(result.signal).toBeNull();
	expect(new TextDecoder().decode(result.stdout)).toBe("ÆØÅ");
	expect(new TextDecoder().decode(result.stderr)).toBe("diagnostic");
});
test("HOST guardian refuses direct non-isolated invocation before group signalling @unit", async () => {
	const child = spawn(
		process.execPath,
		[new URL("./process-guardian.ts", import.meta.url).pathname],
		{ detached: false, stdio: ["ignore", "pipe", "pipe"] },
	);
	const close = new Promise<number | null>((resolve, reject) => {
		child.once("close", resolve);
		child.once("error", reject);
	});
	const stderr: Buffer[] = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.stdout.resume();
	expect(await close).toBe(2);
	expect(Buffer.concat(stderr).toString()).toContain("non-isolated");
	// This caller/its process group remains alive after the helper's refusal.
	expect(process.pid).toBeGreaterThan(0);
});
test("HOST timeout refuses exit-zero parent with inherited-pipe descendant and prevents later marker @unit", async () => {
	const world = scratchWorld();
	const marker = join(world.home, "late-marker");
	const grand =
		"setTimeout(()=>Bun.write(" +
		JSON.stringify(marker) +
		",'escaped'),300);setTimeout(()=>process.exit(0),1500)";
	const parent =
		"Bun.spawn([process.execPath,'-e'," +
		JSON.stringify(grand) +
		"],{stdout:'inherit',stderr:'inherit'});setTimeout(()=>process.exit(0),10)";
	try {
		const started = performance.now();
		await expect(
			hostProcess([process.execPath, "-e", parent], {
				timeoutMs: 100,
				cwd: world.home,
			}),
		).rejects.toThrow("deadline");
		expect(performance.now() - started).toBeLessThan(1000);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(await Bun.file(marker).exists()).toBe(false);
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 1600));
		world.clean();
	}
});
test("HOST primitive joins inherited EOF before success and tears down its owned group @unit", async () => {
	const started = performance.now();
	const grand =
		"setTimeout(()=>{console.log('joined descendant');process.exit(0)},120)";
	const parent =
		"Bun.spawn([process.execPath,'-e'," +
		JSON.stringify(grand) +
		"],{stdout:'inherit',stderr:'inherit'});setTimeout(()=>process.exit(0),10)";
	const result = await hostProcess([process.execPath, "-e", parent], {
		timeoutMs: 2000,
	});
	expect(result.code).toBe(0);
	expect(performance.now() - started).toBeGreaterThan(100);
	expect(new TextDecoder().decode(result.stdout)).toContain(
		"joined descendant",
	);
});
test("HOST primitive refuses combined output overflow, missing executable and pre-abort @unit", async () => {
	await expect(
		hostProcess(
			[
				process.execPath,
				"-e",
				"process.stdout.write('a'.repeat(700));process.stderr.write('b'.repeat(700))",
			],
			{ timeoutMs: 2000, maxBytes: 1000 },
		),
	).rejects.toThrow();
	await expect(
		hostProcess(["/not-a-real-host-command-w29904"], { timeoutMs: 2000 }),
	).rejects.toThrow();
	const abort = new AbortController();
	abort.abort();
	await expect(
		hostProcess([process.execPath, "-e", "process.exit(0)"], {
			timeoutMs: 2000,
			signal: abort.signal,
		}),
	).rejects.toThrow();
});

test("HOST primitive resolves guardian from checkout paths containing spaces and URL characters @unit", async () => {
	const world = scratchWorld();
	const directory = join(world.home, "tool space #encoded");
	try {
		await mkdir(directory, { recursive: true });
		await mkdir(join(directory, "node_modules"));
		await symlink(
			dirname(fileURLToPath(import.meta.resolve("zod"))),
			join(directory, "node_modules/zod"),
		);
		for (const name of [
			"process.ts",
			"process-protocol.ts",
			"process-guardian.ts",
		])
			await Bun.write(
				join(directory, name),
				await Bun.file(new URL(name, import.meta.url)).arrayBuffer(),
			);
		const copied = await import(
			pathToFileURL(join(directory, "process.ts")).href
		);
		const result = await copied.hostProcess(
			[process.execPath, "-e", "process.stdout.write('encoded-path-ok')"],
			{ timeoutMs: 2000 },
		);
		expect(result.code).toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toBe("encoded-path-ok");
	} finally {
		world.clean();
	}
});
