import { afterAll, expect, test } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";
import { observation } from "../hooks/lib/observation.ts";
import {
	rowModel,
	type RowProbe,
} from "../hooks/board-html/service-row-model.ts";

const f = await boardFixture(0, afterAll);
const input = () => ({
	laneId: "downstream-lane",
	project: "shared-project",
	originHub: "team-hub",
	peerHub: "regional-hub",
	observedAt: Date.now(),
	expiresAt: Date.now() + 60_000,
});
test("downstream observations require write authorization, preserve origin and peer separately, and never create work sessions", async () => {
	const denied = await fetch(`${f.BASE}/api/lane-observations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input()),
	});
	expect(denied.status).toBe(403);
	const posted = await f.post("/api/lane-observations", input());
	expect(posted.status).toBe(200);
	const snapshot = await fetch(
		`${f.BASE}/api/lane-observations?project=shared-project`,
	).then((r) => r.json());
	expect(snapshot.origins).toEqual(["team-hub"]);
	expect(snapshot.peers).toEqual(["regional-hub"]);
	expect(snapshot.lanes[0].laneId).toBe("downstream-lane");
	const empty = await fetch(
		`${f.BASE}/api/lane-observations?project=other`,
	).then((r) => r.json());
	expect(empty.lanes).toEqual([]);
	const data = await f.getData();
	expect(data.laneObservations.lanes).toHaveLength(1);
	expect(
		data.sessions.some((s: { sid: string }) => s.sid === "downstream-lane"),
	).toBe(false);
	expect(data.observation.source).toBe("governor-ledger");
});
test("observation ingestion rejects unbounded input and invalid provenance", async () => {
	const bad = await f.post("/api/lane-observations", {
		...input(),
		originHub: "unknown",
	});
	expect(bad.status).toBe(400);
	const large = await f.post("/api/lane-observations", {
		...input(),
		project: "x".repeat(9000),
	});
	expect(large.status).toBe(413);
});
test("expired service evidence shows last known state without prescribing a restart", () => {
	const p: RowProbe = {
		id: "sample",
		name: "Sample",
		port: 1,
		up: true,
		state: "up",
		detail: "HTTP 200",
		probed_at: new Date(1000).toISOString(),
		recovery: null,
		observation: observation(
			"probe",
			"sample",
			"local",
			1000,
			100,
			"http-check",
		),
	};
	expect(rowModel(p, 1099).badge).toBe("UP");
	expect(rowModel(p, 1100).badge).toBe("STALE");
	expect(rowModel(p, 1100).saw).toContain("Last known up");
	expect(rowModel({ ...p, up: false, state: "down" }, 1100).showRecovery).toBe(
		false,
	);
});
