import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { realNode } from "./durable-node.fixtures.ts";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

test("Durable SIGKILL mid-tool records interruption without replaying unsafe side effects @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-mid-tool-" }),
		counter = join(world.home, "effects.txt");
	const server = serveStub((_req, _body, n) => fixtureResponse(n));
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
	const input = {
		requestId: "interrupted-tool-1",
		text: "Run probe, then finish.",
	};
	const module = new URL("../hooks/lib/runners/durable/job.ts", import.meta.url)
			.href,
		fixture = new URL("./durable-runtime.fixtures.ts", import.meta.url).href;
	const code = `import {openDurableJob} from ${JSON.stringify(module)};import{createFixtureRuntime}from ${JSON.stringify(fixture)};import{appendFileSync}from'node:fs';const c=JSON.parse(process.env.FLEET_DURABLE_TEST_CONFIG);const runtime=createFixtureRuntime(c.url,async()=>{appendFileSync(c.counter,'effect\\n',{mode:384});console.log('tool-started');await new Promise(()=>{})});const job=await openDurableJob({root:c.root,spec:c.spec,runtime,authorize:async()=>{}});await(await job.submit(c.input)).wait();`;
	const child = Bun.spawn([realNode(), "--input-type=module", "-e", code], {
		env: {
			HOME: world.home,
			PATH: process.env.PATH ?? "",
			FLEET_DURABLE_TEST_CONFIG: JSON.stringify({
				root: world.home,
				spec,
				url: server.url,
				counter,
				input,
			}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
	let job: Awaited<ReturnType<typeof openDurableJob>> | undefined;
	try {
		const reader = child.stdout.getReader();
		let text = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += new TextDecoder().decode(chunk.value);
			if (text.includes("tool-started")) break;
		}
		reader.releaseLock();
		expect(text).toContain("tool-started");
		child.kill("SIGKILL");
		await child.exited;
		clearTimeout(timeout);
		job = await openDurableJob({
			root: world.home,
			spec,
			runtime: createFixtureRuntime(server.url, async () => {
				appendFileSync(counter, "replayed\n");
			}),
			authorize: async () => {},
		});
		const settled = await (await job.submit(input)).wait(
			AbortSignal.timeout(5000),
		);
		expect(settled.status, JSON.stringify(settled)).toBe("done");
		expect(readFileSync(counter, "utf8")).toBe("effect\n");
		expect(server.requests).toHaveLength(2);
		expect(JSON.stringify(server.requests[1].body).toLowerCase()).toContain(
			"interrupted",
		);
	} finally {
		clearTimeout(timeout);
		child.kill("SIGKILL");
		await child.exited;
		await job?.close();
		server.close();
		world.clean();
	}
});
