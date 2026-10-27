import { expect, test } from "bun:test";
import { join } from "node:path";
import { freePort, scratchWorld } from "../../test-kit/src/index.ts";

test("unconfigured MCP serves setup status but never tools", async () => {
	const { env, clean } = scratchWorld({ prefix: "belt-mcp-status-" });
	const port = await freePort();
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "../bin/mcp-server.ts")],
		{
			env: {
				...env,
				BELT_MCP_PORT: String(port),
				BELT_MCP_BIND: "127.0.0.1",
				BELT_MCP_DEV: "0",
				BELT_MCP_TENANT: "",
				BELT_MCP_AUDIENCE: "",
			},
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	try {
		let page: Response | null = null;
		for (let i = 0; i < 50; i++) {
			try {
				page = await fetch(`http://127.0.0.1:${port}/`);
				break;
			} catch {
				await Bun.sleep(20);
			}
		}
		expect(page?.status).toBe(503);
		expect(await page?.text()).toContain("MCP setup needed");
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		expect(health.status).toBe(503);
		expect(((await health.json()) as { status: string }).status).toBe(
			"unconfigured",
		);
		const rpc = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(rpc.status).toBe(503);
	} finally {
		child.kill();
		await child.exited;
		clean();
	}
});
