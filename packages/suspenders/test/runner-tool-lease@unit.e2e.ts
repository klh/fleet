import { expect, test } from "@playwright/test";
import { captureRunnerLeaseFence } from "../hooks/lib/runners/desktop/wiring.ts";

test("late tool results remain bound to the lease that dispatched them", async () => {
	const runId = "fixture-run";
	const tokens = new Map([[runId, { epoch: 1 }]]);
	const capture = captureRunnerLeaseFence(
		() => ({
			async fence({ runId, actor }) {
				if (actor.leaseToken?.epoch !== tokens.get(runId)?.epoch)
					throw new Error("stale lease");
			},
		}),
		"fixture-executor",
		tokens,
	);
	const inFlight = capture(runId);
	await inFlight();
	tokens.set(runId, { epoch: 2 });
	await expect(inFlight()).rejects.toThrow("stale lease");
	await capture(runId)();
});
