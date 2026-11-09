import { expect, test } from "@playwright/test";
import type {
	RegistrationClient,
	RegistrationResult,
	WorkerAnnouncement,
} from "../src/registration.ts";
import {
	WorkerHeartbeat,
	type HeartbeatClock,
	type HeartbeatEvent,
} from "../src/heartbeat.ts";

function fakeClock() {
	const scheduled: { callback: () => void; ms: number }[] = [];
	const clock: HeartbeatClock = {
		setInterval: (callback, ms) => {
			scheduled.push({ callback, ms });
			return scheduled.length - 1;
		},
		clearInterval: (handle) => {
			scheduled[handle as number] = { callback: () => {}, ms: 0 };
		},
	};
	return {
		clock,
		tick: (index = 0) => scheduled[index]?.callback(),
		scheduled,
	};
}

function fakeClient(results: RegistrationResult[]): {
	client: RegistrationClient;
	calls: WorkerAnnouncement[];
} {
	const calls: WorkerAnnouncement[] = [];
	let i = 0;
	return {
		calls,
		client: {
			async register(announcement) {
				calls.push(announcement);
				return results[Math.min(i++, results.length - 1)] ?? { ok: true };
			},
		},
	};
}

const base: WorkerAnnouncement = {
	sid: "autow2888-p1",
	name: "pi-durable-worker",
	origin: { kind: "session", id: "autow2888-p1" },
	compute: { kind: "hub", host: "muramasa" },
	state: "running",
};

test("start() announces immediately and schedules the heartbeat interval", async () => {
	const { clock } = fakeClock();
	const { client, calls } = fakeClient([{ ok: true }]);
	const events: HeartbeatEvent[] = [];
	const hb = new WorkerHeartbeat({
		client,
		intervalMs: 5_000,
		clock,
		snapshot: () => base,
		onEvent: (e) => events.push(e),
	});
	await hb.start();
	expect(calls).toHaveLength(1);
	expect(events).toEqual([{ kind: "announce", ok: true }]);
});

test("each interval tick re-registers with a fresh snapshot", async () => {
	const { clock, tick } = fakeClock();
	const { client, calls } = fakeClient([{ ok: true }, { ok: true }]);
	let state = "running";
	const hb = new WorkerHeartbeat({
		client,
		intervalMs: 5_000,
		clock,
		snapshot: () => ({ ...base, state }),
	});
	await hb.start();
	state = "idle";
	await tick();
	expect(calls.map((c) => c.state)).toEqual(["running", "idle"]);
});

test("announceChange() re-registers out-of-band without waiting for the next tick", async () => {
	const { clock } = fakeClock();
	const { client, calls } = fakeClient([{ ok: true }, { ok: true }]);
	const hb = new WorkerHeartbeat({
		client,
		intervalMs: 60_000,
		clock,
		snapshot: () => base,
	});
	await hb.start();
	await hb.announceChange();
	expect(calls).toHaveLength(2);
});

test("a hub-dark registration reports ok:false through onEvent, never throwing", async () => {
	const { clock } = fakeClock();
	const { client } = fakeClient([{ ok: false, reason: "hub unreachable" }]);
	const events: HeartbeatEvent[] = [];
	const hb = new WorkerHeartbeat({
		client,
		intervalMs: 5_000,
		clock,
		snapshot: () => base,
		onEvent: (e) => events.push(e),
	});
	await expect(hb.start()).resolves.toBeUndefined();
	expect(events).toEqual([
		{ kind: "announce", ok: false, reason: "hub unreachable" },
	]);
});

test("stop() clears the interval so no further ticks fire", async () => {
	const { clock, scheduled } = fakeClock();
	const { client } = fakeClient([{ ok: true }]);
	const hb = new WorkerHeartbeat({
		client,
		intervalMs: 5_000,
		clock,
		snapshot: () => base,
	});
	await hb.start();
	hb.stop();
	expect(scheduled[0]?.ms).toBe(0);
});
