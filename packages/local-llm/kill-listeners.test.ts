import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { killListeners } from "./kill-listeners.ts";

test("port recovery kills its listener while leaving the probing process alive", async () => {
	const listener = Bun.spawn(
		[
			process.execPath,
			"-e",
			'const server = require("node:net").createServer(() => {}); server.listen(0, "127.0.0.1", () => console.log(server.address().port));',
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = listener.stdout.getReader();
	let client: ReturnType<typeof createConnection> | undefined;
	try {
		const first = await reader.read();
		const port = Number(new TextDecoder().decode(first.value).trim());
		expect(port).toBeGreaterThan(0);
		client = createConnection({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			client?.once("connect", resolve);
			client?.once("error", reject);
		});
		const allSockets = Bun.spawnSync(["/usr/sbin/lsof", "-t", `-iTCP:${port}`]);
		expect(allSockets.stdout.toString().split(/\s+/)).toContain(
			String(process.pid),
		);
		killListeners(port);
		await listener.exited;
		expect(listener.signalCode).toBe("SIGKILL");
		expect(
			Bun.spawnSync(["/bin/kill", "-0", String(process.pid)]).exitCode,
		).toBe(0);
	} finally {
		client?.destroy();
		reader.releaseLock();
		listener.kill();
	}
});
