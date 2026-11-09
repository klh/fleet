import { randomUUID } from "node:crypto";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

test("Registry seed updates affect the next job while active jobs retain their tool code @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-seed-" });
	const server = serveStub((_req, _body, n) =>
		fixtureResponse(n % 2 === 1 ? 1 : 2),
	);
	let oldCalls = 0,
		newCalls = 0;
	const runtime = createFixtureRuntime(server.url, async () => {
		oldCalls++;
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
	const first = await openDurableJob({
		root: world.home,
		spec,
		runtime,
		authorize: async () => {},
	});
	let second: Awaited<ReturnType<typeof openDurableJob>> | undefined;
	try {
		const replacement = createFixtureRuntime(server.url, async () => {
			newCalls++;
		});
		for (const extension of replacement.registry.snapshot().installed())
			runtime.registry.install(extension);
		expect(
			(
				await (
					await first.submit({ requestId: "old-seed", text: "Run probe." })
				).wait(AbortSignal.timeout(5000))
			).status,
		).toBe("done");
		expect([oldCalls, newCalls]).toEqual([1, 0]);
		second = await openDurableJob({
			root: world.home,
			spec: { ...spec, runId: randomUUID(), seedDigest: "c".repeat(64) },
			runtime,
			authorize: async () => {},
		});
		expect(
			(
				await (
					await second.submit({ requestId: "new-seed", text: "Run probe." })
				).wait(AbortSignal.timeout(5000))
			).status,
		).toBe("done");
		expect([oldCalls, newCalls]).toEqual([1, 1]);
	} finally {
		await first.close();
		await second?.close();
		server.close();
		world.clean();
	}
});
