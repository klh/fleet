import { expect, test } from "@playwright/test";
import { apiWorld } from "./runner-api.fixture.ts";

test("HTTP admission pins host profile and enforces owner on every action @unit", async () => {
	const world = apiWorld();
	try {
		const runId = crypto.randomUUID();
		expect(
			(await world.request("alice", "/runs", { runId, profile: "standard" }))
				.status,
		).toBe(201);
		expect((await world.request("bob", `/runs/${runId}`)).status).toBe(403);
		expect((await (await world.request("bob", "/runs")).json()).runs).toEqual(
			[],
		);
		expect(
			(await (await world.request("alice", "/runs")).json()).runs[0].runId,
		).toBe(runId);
		expect(
			(
				await world.request("bob", `/runs/${runId}/submit`, {
					text: "hello",
					requestId: crypto.randomUUID(),
				})
			).status,
		).toBe(403);
		const read = await world.request("alice", `/runs/${runId}`);
		expect(read.status).toBe(200);
		expect(JSON.stringify(await read.json())).not.toContain("leaseToken");
		expect(
			(
				await world.request("alice", `/runs/${runId}/submit`, {
					text: "hello",
					requestId: crypto.randomUUID(),
				})
			).status,
		).toBe(200);
		expect(world.calls).toEqual(["start", "submit"]);
		expect(
			(
				await world.request("alice", "/runs", {
					runId: crypto.randomUUID(),
					profile: "standard",
					owner: "bob",
					model: "forged",
				})
			).status,
		).toBe(400);
	} finally {
		world.close();
	}
});

test("executor cannot supply takeover epoch over HTTP @unit", async () => {
	const world = apiWorld();
	try {
		const runId = crypto.randomUUID();
		await world.request("alice", "/runs", { runId, profile: "standard" });
		world.bindings.register({
			keyId: "executor",
			runId,
			epoch: 1,
			expiresAt: Date.now() + 60_000,
		});
		expect(
			(await world.request("executor", `/runs/${runId}/fence`, {})).status,
		).toBe(200);
		expect(
			(await world.request("executor", `/runs/${runId}/fence`, { epoch: 2 }))
				.status,
		).toBe(400);
		expect(
			(await world.request("other", `/runs/${runId}/fence`, {})).status,
		).toBe(403);
		world.store.run(
			"UPDATE runner_leases SET epoch = 2 WHERE run_id = ?",
			runId,
		);
		expect(
			(await world.request("executor", `/runs/${runId}/fence`, {})).status,
		).toBe(403);
	} finally {
		world.close();
	}
});
