import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

test("Real Durable harness completes a tool round and does not repeat a completed request after reopen @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-tool-" });
	let executions = 0;
	const server = serveStub((_request, _body, n) => fixtureResponse(n));
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
	const options = {
		root: world.home,
		spec,
		runtime: createFixtureRuntime(server.url, async () => {
			executions++;
		}),
		authorize: async () => {},
	};
	let job: Awaited<ReturnType<typeof openDurableJob>> | undefined;
	try {
		job = await openDurableJob(options);
		const input = {
			requestId: "fixture-tool-1",
			text: "Run probe, then say done.",
		};
		const submission = await job.submit(input);
		const settled = await submission.wait(AbortSignal.timeout(5000));
		expect(settled.status, JSON.stringify(settled)).toBe("done");
		expect(server.requests[1].body).toMatchObject({
			messages: expect.arrayContaining([
				{ role: "tool", content: "ok", tool_call_id: "call-fixture" },
			]),
		});
		expect(executions).toBe(1);
		expect(server.requests).toHaveLength(2);
		await job.close();
		job = await openDurableJob(options);
		const repeated = await job.submit(input);
		expect(repeated.id).toBe(submission.id);
		expect((await repeated.wait()).status).toBe("done");
		expect(executions).toBe(1);
		expect(server.requests).toHaveLength(2);
	} finally {
		await job?.close();
		server.close();
		world.clean();
	}
});
