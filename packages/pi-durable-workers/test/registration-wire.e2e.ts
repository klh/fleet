// Integration proof (W2888 review 01a186a5): drives the REAL argv parser
// `coord workers register` uses (packages/suspenders/hooks/coord/shared.ts
// `arg()`/`setRest()`), not a mock of it — proves `toRegisterArgs` produces
// an argv the actual receiver reads correctly. `workers.ts` itself (W2886,
// unmerged sibling branch) is out of this lane's diff; this is the
// integration surface available without depending on unlanded code.
import { expect, test } from "@playwright/test";
import { arg, setRest } from "../../suspenders/hooks/coord/shared.ts";
import {
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

test("toRegisterArgs produces an argv the real coord `arg()` parser reads back field-for-field", () => {
	setRest(toRegisterArgs(announcement));
	expect(arg("--as")).toBe("autow2888-p1");
	expect(arg("--name")).toBe("pi-durable-worker");
	expect(arg("--description")).toBe("test worker");
	expect(arg("--purpose")).toBe("wake-on-timer");
	expect(arg("--origin-kind")).toBe("session");
	expect(arg("--origin-id")).toBe("autow2888-p1");
	expect(arg("--compute-kind")).toBe("hub");
	expect(arg("--host")).toBe("muramasa");
	expect(arg("--region")).toBe("local");
	expect(arg("--hub-id")).toBe("muramasa");
	expect(arg("--owner-sid")).toBe("autow2888-p1");
	expect(arg("--state")).toBe("running");
	expect(arg("--task")).toBe("W2888");
	expect(JSON.parse(arg("--activity") ?? "[]")).toEqual([
		{ at: 1, kind: "registering" },
	]);
});

test("an omitted optional field is simply absent from argv, never emitted as a literal 'undefined'", () => {
	setRest(toRegisterArgs({ ...announcement, description: undefined }));
	expect(arg("--description")).toBeNull();
});
