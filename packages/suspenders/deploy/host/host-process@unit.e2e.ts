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
	const running = hostArgv([process.execPath, "-e", script], 2000).then(
		() => undefined,
		(error: unknown) => error,
	);
	let pid: number | undefined;
	const clean = async () => {
		try {
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
		if (!(result instanceof Error))
			throw new Error("HOST deadline did not refuse");
		expect(result.message).toMatch(/deadline/);
		expect(() => process.kill(pid ?? 0, 0)).toThrow();
	} finally {
		await clean();
	}
});
