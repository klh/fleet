import { expect, test } from "@playwright/test";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { apiWorld } from "./runner-api.fixture.ts";

test("abort fences an in-flight cold start before it can submit @unit", async () => {
	const world = apiWorld();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let submissions = 0;
	try {
		const runId = crypto.randomUUID();
		await world.request("alice", "/runs", { runId, profile: "standard" });
		const actor = { sid: "alice", scopes: ["buckle:runner:WRITE_"] };
		const controller = openRunnerController({
			store: world.store,
			durable: {
				async start() {
					entered.resolve();
					await release.promise;
				},
				async resume() {},
				async stop() {},
				async submit() {
					submissions++;
				},
			},
		});
		const pending = controller.submit({ runId, actor, text: "probe" });
		await entered.promise;
		try {
			await controller.stopWithRevocation({ runId, actor });
		} finally {
			release.resolve();
		}
		expect(await pending).toMatchObject({ ok: false });
		expect(submissions).toBe(0);
	} finally {
		world.close();
	}
});
