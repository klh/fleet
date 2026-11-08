import { expect, test } from "@playwright/test";
import { apiWorld } from "./runner-api.fixture.ts";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";

test("cleanup errors cannot expose provider bodies or credentials through the feed @unit", async () => {
	const world = apiWorld();
	try {
		const runId = crypto.randomUUID();
		await world.request("alice", "/runs", { runId, profile: "standard" });
		const controller = openRunnerController({
			store: world.store,
			durable: {
				async start() {},
				async submit() {},
				async resume() {},
				async stop() {
					throw new Error("Authorization: Bearer fixture-secret-provider-body");
				},
			},
		});
		await controller.stopWithRevocation({
			runId,
			actor: { sid: "alice", scopes: ["buckle:runner:WRITE_"] },
		});
		const response = await world.request("alice", `/runs/${runId}`);
		const body = await response.text();
		expect(body).not.toContain("fixture-secret-provider-body");
		expect(body).toContain("executor stop failed");
	} finally {
		world.close();
	}
});
