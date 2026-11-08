import { expect, test } from "@playwright/test";
import { apiWorld } from "./runner-api.fixture.ts";
import { recordRunnerEvent } from "../hooks/lib/runners/control/cursors.ts";

test("reader pages stay bounded and independent, detach does not abort @unit", async () => {
	const world = apiWorld();
	try {
		const runId = crypto.randomUUID();
		await world.request("alice", "/runs", { runId, profile: "standard" });
		for (let index = 0; index < 100; index++)
			recordRunnerEvent(world.store, {
				runId,
				kind: "fixture",
				payload: { index },
				now: Date.now(),
			});
		const first = { readerId: crypto.randomUUID() };
		const second = { readerId: crypto.randomUUID() };
		await world.request("alice", `/runs/${runId}/attach`, first);
		await world.request("alice", `/runs/${runId}/attach`, second);
		const page = await (
			await world.request("alice", `/runs/${runId}/replay`, first)
		).json();
		expect(page.events).toHaveLength(32);
		const next = await (
			await world.request("alice", `/runs/${runId}/replay`, first)
		).json();
		expect(next.events[0].id).toBeGreaterThan(page.cursor);
		const independent = await (
			await world.request("alice", `/runs/${runId}/replay`, second)
		).json();
		expect(independent.events).toEqual(page.events);
		await world.request("alice", `/runs/${runId}/detach`, first);
		expect(world.calls).not.toContain("stop");
		expect(
			(await (await world.request("alice", `/runs/${runId}`)).json()).events,
		).toHaveLength(32);
	} finally {
		world.close();
	}
});
