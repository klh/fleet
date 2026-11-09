import { expect, test } from "@playwright/test";
import {
	createCoordRegistrationClient,
	toRegisterArgs,
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
	activity: [{ at: 1, kind: "registering" }],
};

test("toRegisterArgs emits --as plus one flag per field, matching the real receiver's argv shape", () => {
	expect(toRegisterArgs(announcement)).toEqual([
		"--as",
		"autow2888-p1",
		"--name",
		"pi-durable-worker",
		"--description",
		"test worker",
		"--purpose",
		"wake-on-timer",
		"--origin-kind",
		"session",
		"--origin-id",
		"autow2888-p1",
		"--compute-kind",
		"hub",
		"--host",
		"muramasa",
		"--region",
		"local",
		"--hub-id",
		"muramasa",
		"--owner-sid",
		"autow2888-p1",
		"--state",
		"running",
		"--task",
		"W2888",
		"--activity",
		JSON.stringify(announcement.activity),
	]);
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
