import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ObservationOutbox } from "../../../buckle/src/observe.ts";
import { projectLanes } from "./observation-plane.ts";
import {
	mapCloudEvent,
	ObservationProducer,
	startObservationPlaneProducer,
} from "./observation-producer.ts";

const NOW = 1_700_000_000_000;

function cloud(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		specversion: "1.0",
		type: "lane.request.started",
		source: "buckle://local/boot-1",
		id: "1",
		time: new Date(NOW).toISOString(),
		data: {
			rid: "r1",
			lane: "lane-a",
			actor: "sid-1",
			dialect: "anthropic",
			model: "m",
			traceparent: "tp",
		},
		...over,
	};
}

describe("mapCloudEvent", () => {
	test("maps the buckle vocabulary onto the plane contract", () => {
		const e = mapCloudEvent(
			cloud({
				type: "lane.request.ended",
				id: "3",
				data: {
					rid: "r1",
					lane: "lane-a",
					actor: "sid-1",
					dialect: "anthropic",
					model: "m",
					traceparent: "tp",
					outcome: "ok",
					latencyMs: 42,
				},
			}),
		);
		expect(e?.type).toBe("request.ended");
		expect(e?.bootId).toBe("boot-1");
		expect(e?.seq).toBe(3);
		expect(e?.projectId).toBe("sid-1");
		expect(e?.laneId).toBe("lane-a");
		expect(e?.requestId).toBe("r1");
		expect(e?.outcome).toBe("ok");
		expect(e?.latencyMs).toBe(42);
	});

	test("non-ok outcomes collapse to error", () => {
		const e = mapCloudEvent(
			cloud({ type: "lane.request.ended", data: { outcome: "denied" } }),
		);
		expect(e?.outcome).toBe("error");
	});
	test("foreign spec, unknown type, bad id and bad time do not map", () => {
		expect(mapCloudEvent(cloud({ specversion: "0.3" }))).toBeNull();
		expect(mapCloudEvent(cloud({ type: "mystery" }))).toBeNull();
		expect(mapCloudEvent(cloud({ id: "x9" }))).toBeNull();
		expect(mapCloudEvent(cloud({ time: "not-a-time" }))).toBeNull();
		expect(mapCloudEvent(null)).toBeNull();
	});
});

const DATA = {
	rid: "r1",
	lane: "lane-a",
	actor: "sid-1",
	dialect: "anthropic",
	model: "m",
	traceparent: "tp",
};

function tmpOutbox(name: string): string {
	return join(mkdtempSync(join(tmpdir(), "obp-")), name);
}

describe("ObservationProducer", () => {
	test("a request flows to the grouped read model", async () => {
		const path = tmpOutbox("out.ndjson");
		const ob = new ObservationOutbox({ path, bootId: "boot-1" });
		ob.emit("lane.request.admitted", { ...DATA });
		ob.emit("lane.request.started", { ...DATA });
		ob.emit("lane.request.ended", {
			...DATA,
			outcome: "ok",
			status: 200,
			latencyMs: 120,
		});
		await new Promise((r) => setTimeout(r, 50));
		const db = new Database(":memory:");
		const producer = new ObservationProducer(db, path);
		const r1 = await producer.poll();
		expect(r1.seen).toBe(3);
		expect(r1.mapped).toBe(3);
		expect(r1.accepted).toBe(3);
		expect(r1.duplicates).toBe(0);
		const view = projectLanes(db, { visibility: "owns" }, NOW + 1);
		const lane = view.lanes.find((l) => l.laneId === "lane-a");
		expect(lane).not.toBeUndefined();
		expect(lane?.detail?.requestId).toBe("r1");
		expect(view.counts.requests).toBe(1);
		expect(view.latencyMs.avg).toBe(120);
		const r2 = await producer.poll();
		expect(r2.seen).toBe(0);
		const after = projectLanes(db, { visibility: "owns" }, NOW + 1);
		expect(after.counts.requests).toBe(1);
	});

	test("replay after rotation dedups instead of double-counting", async () => {
		const path = tmpOutbox("out.ndjson");
		const lines = [
			`${JSON.stringify(cloud({ id: "1" }))}\n`,
			`${JSON.stringify(cloud({ id: "2" }))}\n`,
			`${JSON.stringify(cloud({ id: "3" }))}\n`,
		];
		writeFileSync(path, lines.join(""));
		const db = new Database(":memory:");
		const producer = new ObservationProducer(db, path);
		const r1 = await producer.poll();
		expect(r1.accepted).toBe(3);
		writeFileSync(path, lines[0]);
		const r2 = await producer.poll();
		expect(r2.seen).toBe(1);
		expect(r2.duplicates).toBe(1);
	});

	test("a torn tail line waits for the next poll", async () => {
		const path = tmpOutbox("out.ndjson");
		const whole = `${JSON.stringify(cloud({ id: "1" }))}\n`;
		writeFileSync(path, `${whole}{"specversion":"1.0","type":`);
		const db = new Database(":memory:");
		const producer = new ObservationProducer(db, path);
		const r1 = await producer.poll();
		expect(r1.seen).toBe(1);
		appendFileSync(path, `"lane.request.started"}\n`);
		const r2 = await producer.poll();
		expect(r2.seen).toBe(1);
	});

	test("the producer loop is config-gated", async () => {
		const saved = process.env.KLH_OBSERVATION_OUTBOX;
		try {
			delete process.env.KLH_OBSERVATION_OUTBOX;
			const off = startObservationPlaneProducer(new Database(":memory:"));
			expect(off.enabled).toBe(false);
			expect(await off.tick()).toBeNull();
			process.env.KLH_OBSERVATION_OUTBOX = tmpOutbox("absent.ndjson");
			const on = startObservationPlaneProducer(new Database(":memory:"), {
				autoStart: false,
			});
			expect(on.enabled).toBe(true);
			const r = await on.tick();
			expect(r?.seen).toBe(0);
			on.stop();
		} finally {
			if (saved === undefined) delete process.env.KLH_OBSERVATION_OUTBOX;
			else process.env.KLH_OBSERVATION_OUTBOX = saved;
		}
	});
});
