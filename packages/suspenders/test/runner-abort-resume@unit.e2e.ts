import { expect, test } from "@playwright/test";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { apiWorld } from "./runner-api.fixture.ts";

test("aborting a parked run during resume preserves its held submissions @unit", async () => {
	const world = apiWorld();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let deliveries = 0;
	try {
		const runId = crypto.randomUUID();
		const actor = { sid: "alice", scopes: ["buckle:runner:WRITE_"] };
		await world.request("alice", "/runs", { runId, profile: "standard" });
		world.store.run(
			"UPDATE runner_jobs SET state = 'parked' WHERE run_id = ?",
			runId,
		);
		const controller = openRunnerController({
			store: world.store,
			durable: {
				async start() {},
				async resume() {
					entered.resolve();
					await release.promise;
				},
				async stop() {},
				async submit() {
					deliveries++;
				},
			},
		});
		await controller.submit({
			runId,
			actor,
			text: "held",
			requestId: "held-1",
		});
		const pending = controller.resume({ runId, actor });
		await entered.promise;
		try {
			await controller.stopWithRevocation({ runId, actor });
		} finally {
			release.resolve();
		}
		expect(await pending).toMatchObject({ ok: false });
		expect(deliveries).toBe(0);
		expect(
			world.store.get(
				"SELECT state, held_interrupts_json FROM runner_jobs WHERE run_id = ?",
				runId,
			),
		).toMatchObject({
			state: "stopping",
			held_interrupts_json: expect.stringContaining("held-1"),
		});
	} finally {
		world.close();
	}
});
