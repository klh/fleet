import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { hostArgv } from "./runtime.fixture.ts";

test("trusted HOST child ignores SIGTERM but deadline SIGKILL is joined @unit", async () => {
	test.setTimeout(10000);
	const world = scratchWorld(),
		pidFile = join(world.home, "pid"),
		ackFile = join(world.home, "ack");
	const script = `const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(ackFile)},"ignored"));fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(77),5000);setInterval(()=>{},100);`;
	const running = hostArgv([process.execPath, "-e", script], 2000);
	let pid: number | undefined;
	const clean = async () => {
		try {
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ESRCH"
						)
					)
						throw error;
				}
			}
			await running;
		} finally {
			world.clean();
		}
	};
	try {
		await expect.poll(() => existsSync(pidFile), { timeout: 1000 }).toBe(true);
		pid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		process.kill(pid, "SIGTERM");
		await expect.poll(() => existsSync(ackFile), { timeout: 500 }).toBe(true);
		expect(() => process.kill(pid ?? 0, 0)).not.toThrow();
		const result = await running;
		expect(result.code).not.toBe(0);
		expect(result.signal).toBe("SIGKILL");
		expect(() => process.kill(pid ?? 0, 0)).toThrow();
	} finally {
		await clean();
	}
});
