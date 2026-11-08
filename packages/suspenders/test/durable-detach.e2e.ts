import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

test("Cancelling a Durable waiter detaches the reader without aborting the job @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-detach-" });
	const server = serveStub((_req, _body, n) => fixtureResponse(n));
	let release: () => void = () => {},
		entered: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const runtime = createFixtureRuntime(server.url, async () => {
		entered();
		await gate;
	});
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
	const job = await openDurableJob({
		root: world.home,
		spec,
		runtime,
		authorize: async () => {},
	});
	try {
		const submission = await job.submit({
			requestId: "detach-1",
			text: "Run the probe.",
		});
		await started;
		await expect(
			submission.wait(AbortSignal.abort(new Error("reader detached"))),
		).rejects.toThrow();
		release();
		expect((await submission.wait(AbortSignal.timeout(5000))).status).toBe(
			"done",
		);
		expect(server.requests).toHaveLength(2);
	} finally {
		release();
		await job.close();
		server.close();
		world.clean();
	}
});
