import { expect, test } from "./pw";
import { hostname } from "node:os";
import {
	compareProcessBirth,
	darwinProcessBirth,
	obsoleteProcessStart,
} from "../scripts/lib/process-birth.ts";
import {
	inspectLaunchIntent,
	processBirth,
	type LaunchIntent,
} from "../scripts/lib/launch-fencing.ts";
import { controllerHolderLiveness } from "../scripts/lib/controller-fence.ts";

const boot = "12345678-1234-1234-1234-123456789abc";
const old = (usec: number, start = "1792697570:312875") =>
	`{ sec = 1791886350, usec = ${usec} } Tue Oct 13 12:12:30 2026:${start}`;
const current = darwinProcessBirth(boot, "1792697570:312875");

test("stable boot session and microsecond start replace mutable wall clock", () => {
	expect(current).toBe(`darwin:${boot}:1792697570:312875`);
	expect(darwinProcessBirth(boot.toUpperCase(), "1792697570:312875")).toBe(
		current,
	);
	expect(darwinProcessBirth(null, "1792697570:312875")).toBeNull();
	expect(darwinProcessBirth("unavailable", "1792697570:312875")).toBeNull();
	expect(darwinProcessBirth(boot, "not-start")).toBeNull();
	expect(obsoleteProcessStart(old(120299))).toBe("1792697570:312875");
});

test("sixteen old live lane identities are unknown, never prunable after clock drift", () => {
	if (!current) throw Error("fixture birth absent");
	for (let index = 0; index < 16; index++) {
		const birth = old(120299 + index);
		const intent: LaunchIntent = {
			project: "fixture",
			item: `W${index}`,
			sid: `lane${index}`,
			nonce: "fixture",
			revision: 1,
			executor: "/fixture/runtime.ts",
			host: hostname(),
			attempt: 0,
			state: "REGISTERED",
			pid: process.pid,
			birth,
		};
		const inspect = () => ({
			birth: current,
			command: "/fixture/runtime.ts --managed",
		});
		expect(compareProcessBirth(birth, current)).toBe("unknown");
		expect(inspectLaunchIntent(intent, inspect)).toBe("unknown");
		expect(
			controllerHolderLiveness(
				intent as { host: string; pid: number; birth: string },
				inspect,
			),
		).toBe("unknown");
		expect(inspectLaunchIntent(intent, () => false)).toBe("dead");
	}
});

test("PID reuse and boot-session changes remain proven mismatches", () => {
	if (!current) throw Error("fixture birth absent");
	expect(compareProcessBirth(current, current)).toBe("same");
	expect(compareProcessBirth(current, `darwin:${boot}:1792697570:312876`)).toBe(
		"different",
	);
	expect(
		compareProcessBirth(
			current,
			"darwin:87654321-1234-1234-1234-123456789abc:1792697570:312875",
		),
	).toBe("different");
	expect(compareProcessBirth(old(120299), old(120299))).toBe("unknown");
});

test("actual current process identity is stable and boot-session scoped", () => {
	const first = processBirth(process.pid);
	const second = processBirth(process.pid);
	expect(first).toBeTruthy();
	expect(second).toEqual(first);
	if (process.platform === "darwin" && first)
		expect(first.birth).toMatch(/^darwin:[a-f0-9-]{36}:\d+:\d+$/);
});
