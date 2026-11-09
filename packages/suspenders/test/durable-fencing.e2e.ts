import { randomUUID } from "node:crypto";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

test("Durable execution fencing is checked before provider requests and before tool effects @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	for (const allowed of [0, 1]) {
		const world = scratchWorld({ prefix: "durable-fence-" });
		const server = serveStub((_req, _body, n) => fixtureResponse(n));
		let checks = 0,
			effects = 0;
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
			runtime: createFixtureRuntime(server.url, async () => {
				effects++;
			}),
			authorize: async (action) => {
				if (action === "execute" && ++checks > allowed)
					throw new Error("lease revoked");
			},
		});
		try {
			const submission = await job.submit({
				requestId: "fenced-1",
				text: "Run the probe.",
			});
			const settled = await submission.wait(AbortSignal.timeout(5000));
			expect(
				settled.status,
				JSON.stringify({
					checks,
					effects,
					requests: server.requests.length,
					settled,
				}),
			).toBe("unanswered");
			expect(effects).toBe(0);
			expect(server.requests, JSON.stringify({ checks, settled })).toHaveLength(
				allowed,
			);
		} finally {
			await job.close();
			server.close();
			world.clean();
		}
	}
});
