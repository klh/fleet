// Integration proof (W2888 review 01a186a5): drives an argv parser against
// `toRegisterArgs`'s output to prove the shapes line up field-for-field.
// `workers.ts` (W2886, unmerged sibling branch) is out of this lane's diff,
// and import-law (W1249/W1302.4) forbids a relative reach-in into another
// package — `parseArg` below is a verbatim port of coord/shared.ts's
// `arg()` (indexOf name, return the next token), not a fresh algorithm, so
// this stays a faithful proof of the real receiver's parsing contract.
import { expect, test } from "@playwright/test";
import {
	toRegisterArgs,
	type WorkerAnnouncement,
} from "../src/registration.ts";

function parseArg(argv: readonly string[], name: string): string | null {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
}

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
	const argv = toRegisterArgs(announcement);
	expect(parseArg(argv, "--as")).toBe("autow2888-p1");
	expect(parseArg(argv, "--name")).toBe("pi-durable-worker");
	expect(parseArg(argv, "--description")).toBe("test worker");
	expect(parseArg(argv, "--purpose")).toBe("wake-on-timer");
	expect(parseArg(argv, "--origin-kind")).toBe("session");
	expect(parseArg(argv, "--origin-id")).toBe("autow2888-p1");
	expect(parseArg(argv, "--compute-kind")).toBe("hub");
	expect(parseArg(argv, "--host")).toBe("muramasa");
	expect(parseArg(argv, "--region")).toBe("local");
	expect(parseArg(argv, "--hub-id")).toBe("muramasa");
	expect(parseArg(argv, "--owner-sid")).toBe("autow2888-p1");
	expect(parseArg(argv, "--state")).toBe("running");
	expect(parseArg(argv, "--task")).toBe("W2888");
	expect(JSON.parse(parseArg(argv, "--activity") ?? "[]")).toEqual([
		{ at: 1, kind: "registering" },
	]);
});

test("an omitted optional field is simply absent from argv, never emitted as a literal 'undefined'", () => {
	const argv = toRegisterArgs({ ...announcement, description: undefined });
	expect(parseArg(argv, "--description")).toBeNull();
});
