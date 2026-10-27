import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("board fixture exits when its test runner is killed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "board-fixture-death-"));
	const marker = join(dir, "started.json");
	const modulePath = new URL("./helpers/board-fixture.ts", import.meta.url)
		.pathname;
	const script = `
		import { boardFixture } from ${JSON.stringify(modulePath)};
		const fixture = await boardFixture(0, () => {});
		await Bun.write(${JSON.stringify(marker)}, JSON.stringify({
			port: fixture.PORT, pid: fixture.proc.pid,
			dirs: [fixture.HOME, fixture.REPO, fixture.GREPO]
		}));
		await Bun.sleep(60_000);
	`;
	const runner = Bun.spawn(["bun", "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	let fixture: { port: number; pid: number; dirs: string[] } | undefined;
	let stopped = false;
	try {
		for (let i = 0; i < 100 && !existsSync(marker); i++) {
			if (runner.exitCode !== null) break;
			await Bun.sleep(100);
		}
		if (!existsSync(marker)) {
			runner.kill();
			const stderr = await new Response(runner.stderr).text();
			throw new Error(`fixture runner did not start: ${stderr}`);
		}
		fixture = JSON.parse(readFileSync(marker, "utf8")) as {
			port: number;
			pid: number;
			dirs: string[];
		};
		const url = `http://127.0.0.1:${fixture.port}/api/data`;
		expect((await fetch(url)).ok).toBe(true);
		runner.kill("SIGKILL");
		await runner.exited;

		for (let i = 0; i < 50; i++) {
			try {
				await fetch(url, { signal: AbortSignal.timeout(200) });
			} catch {
				stopped = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(stopped).toBe(true);
		for (let i = 0; i < 50 && fixture.dirs.some(existsSync); i++) {
			await Bun.sleep(100);
		}
		expect(fixture.dirs.some(existsSync)).toBe(false);
	} finally {
		runner.kill();
		await runner.exited;
		if (fixture && !stopped) {
			try {
				process.kill(fixture.pid, "SIGTERM");
			} catch {}
		}
		for (const path of fixture?.dirs ?? []) {
			rmSync(path, { recursive: true, force: true });
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
