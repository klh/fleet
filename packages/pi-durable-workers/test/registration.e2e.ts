import { expect, test } from "@playwright/test";
import {
	createCoordRegistrationClient,
	toWirePayload,
	type WorkerAnnouncement,
} from "../src/registration.ts";

const announcement: WorkerAnnouncement = {
	sid: "autow2888-p1",
	name: "pi-durable-worker",
	description: "test worker",
	purpose: "wake-on-timer",
	origin: { kind: "session", id: "autow2888-p1" },
	compute: {
		kind: "hub",
		host: "muramasa",
		region: "local",
		hubId: "muramasa",
	},
	ownerSid: "autow2888-p1",
	state: "running",
	task: "W2888",
	activity: "registering",
};

test("toWirePayload maps camelCase fields to the agreed snake_case wire shape", () => {
	expect(toWirePayload(announcement)).toEqual({
		sid: "autow2888-p1",
		name: "pi-durable-worker",
		description: "test worker",
		purpose: "wake-on-timer",
		origin_kind: "session",
		origin_id: "autow2888-p1",
		compute_kind: "hub",
		compute_host: "muramasa",
		compute_region: "local",
		hub_id: "muramasa",
		owner_sid: "autow2888-p1",
		state: "running",
		task: "W2888",
		activity: "registering",
	});
});

test("register() reports ok on a zero exit", async () => {
	const client = createCoordRegistrationClient({
		coordBin: "coord.ts",
		spawn: async () => ({ exitCode: 0, stderr: "" }),
	});
	expect(await client.register(announcement)).toEqual({ ok: true });
});

test("register() reports the reason on a non-zero exit, never throwing", async () => {
	const client = createCoordRegistrationClient({
		coordBin: "coord.ts",
		spawn: async () => ({ exitCode: 1, stderr: "unknown command: workers\n" }),
	});
	expect(await client.register(announcement)).toEqual({
		ok: false,
		reason: "unknown command: workers",
	});
});

test("register() reports a spawn exception as a non-ok result, never propagating it", async () => {
	const client = createCoordRegistrationClient({
		coordBin: "coord.ts",
		spawn: async () => {
			throw new Error("hub dark");
		},
	});
	expect(await client.register(announcement)).toEqual({
		ok: false,
		reason: "hub dark",
	});
});
