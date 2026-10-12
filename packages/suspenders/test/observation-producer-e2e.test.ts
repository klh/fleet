// test/observation-producer-e2e.test.ts — W705: the producer path end to
// end. A real buckle ObservationOutbox feeds a real board spawned with
// KLH_OBSERVATION_OUTBOX set; the board's own producer loop tails the file
// and a proxied request shows on the grouped board query
// (/api/observation-plane/lanes) — the W705 acceptance surface.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationOutbox } from "../../buckle/src/observe.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const outboxPath = join(
	mkdtempSync(join(tmpdir(), "obp-e2e-")),
	"out.ndjson",
);
const f = await boardFixture(0, afterAll, {
	KLH_OBSERVATION_OUTBOX: outboxPath,
});

interface E2ELane {
	projectId: string;
	detail: { requestId: string | null } | null;
}

test("a buckle request shows on the grouped board query", async () => {
	const ob = new ObservationOutbox({
		path: outboxPath,
		hubId: "e2e-hub",
		bootId: "e2e-boot",
	});
	const data = {
		rid: "e2e-r1",
		lane: "e2e-lane",
		actor: "e2e-sid",
		dialect: "anthropic",
		model: "test-model",
		traceparent: "00-trace-span-01",
	};
	ob.emit("lane.request.admitted", data);
	ob.emit("lane.request.started", data);
	ob.emit("lane.request.ended", {
		...data,
		outcome: "ok",
		status: 200,
		latencyMs: 55,
	});
	// the board's producer tick (2s default) drains the file; poll the
	// grouped query until the request's END has landed (detail only exists
	// once request.ended ingested, so a partial batch never asserts)
	let lane: E2ELane | undefined;
	for (let i = 0; i < 30; i++) {
		await f.sleep(500);
		const lanes = await fetch(
			`${f.BASE}/api/observation-plane/lanes?visibility=owns`,
			{ headers: { "x-klh-write-token": f.TOKEN } },
		).then((r) => r.json());
		const hit = lanes.lanes?.find(
			(l: { laneId: string }) => l.laneId === "e2e-lane",
		);
		if (hit?.detail?.requestId !== "e2e-r1") continue;
		lane = hit;
		expect(lanes.counts.requests).toBe(1);
		expect(lanes.counts.errors).toBe(0);
		expect(lanes.latencyMs.max).toBe(55);
		expect(lane.projectId).toBe("e2e-sid");
		return;
	}
	throw new Error("request never showed on the grouped board query");
}, 25_000);
