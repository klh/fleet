import { randomUUID } from "node:crypto";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { realNode } from "./durable-node.fixtures.ts";

test("Durable foundation reopens under real Node with no Bun global @unit", async () => {
	const world = scratchWorld({ prefix: "durable-node-" });
	const node = realNode();
	if (!node)
		throw new Error("Real Node executable required; set FLEET_TEST_NODE_BIN");
	const spec = {
		version: 1,
		runId: randomUUID(),
		owner: "fixture",
		generation: 1,
		kind: "knowledge",
		seedDigest: "a".repeat(64),
		policyDigest: "b".repeat(64),
		provider: "fixture",
		model: "fixture",
	};
	const script = `import{openDurableJob}from${JSON.stringify(new URL("../hooks/lib/runners/durable/job.ts", import.meta.url).href)};import{createModels}from${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/models"))};import{createRegistry}from${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};const options={root:process.cwd(),spec:${JSON.stringify(spec)},runtime:{models:createModels(),registry:createRegistry()},authorize:async()=>{}};let job=await openDurableJob(options);const id=job.conversationId;await job.close();job=await openDurableJob(options);console.log(JSON.stringify({bun:typeof Bun,reopened:job.conversationId===id}));await job.close();`;
	const child = Bun.spawn([node, "--input-type=module", "-e", script], {
		cwd: world.home,
		env: { HOME: world.home, PATH: process.env.PATH ?? "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			bun: "undefined",
			reopened: true,
		});
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		await child.exited;
		world.clean();
	}
});
