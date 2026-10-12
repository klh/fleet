import { expect, test } from "bun:test";
import { maintainDnsClaims, releaseOwnedClaims } from "./dns-maintenance.ts";

test("reboot pass preserves disabled registrations and retries independent hosts", async () => {
	const calls: string[] = [];
	const errors: string[] = [];
	await maintainDnsClaims({
		registrations: [
			{ name: "belt", dns: { claimed: false } },
			{ name: "waiting", dns: { claimed: true } },
			{ name: "ready", dns: { claimed: true } },
		],
		reconcile: async (name) => {
			calls.push(name);
			if (name === "waiting") throw new Error("Caddy not ready");
		},
		onError: (name) => errors.push(name),
	});
	expect(calls).toEqual(["waiting", "ready"]);
	expect(errors).toEqual(["waiting"]);
});

test("shutdown releases only still-owned exact process identities", () => {
	const terminated: number[] = [];
	releaseOwnedClaims({
		owned: new Map([
			["ours", { pid: 10, argv: ["dns-sd", "ours"] }],
			["reused", { pid: 20, argv: ["dns-sd", "reused"] }],
			["replaced", { pid: 30, argv: ["dns-sd", "replaced"] }],
		]),
		currentPid: (name) => ({ ours: 10, reused: 20, replaced: 31 })[name],
		matches: (pid, argv) => pid === 10 && argv[1] === "ours",
		terminate: (pid) => terminated.push(pid),
	});
	expect(terminated).toEqual([10]);
});
