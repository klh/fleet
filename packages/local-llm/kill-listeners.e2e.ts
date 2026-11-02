// W1294.12 sweep-I: ported from kill-listeners.test.ts to @playwright/test.
import { expect, test } from "@playwright/test";
import { createConnection } from "node:net";
import { killListeners } from "./kill-listeners.ts";

test.describe("@unit", () => {
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
			// playwright workers force color; the child's port line can arrive
			// ANSI-wrapped — strip escapes before parsing (W1294.9.4 lesson)
			const port = Number(
				new TextDecoder()
					.decode(first.value)
					.replace(/\[[0-9;]*[A-Za-z]/g, "")
					.trim(),
			);
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
});
