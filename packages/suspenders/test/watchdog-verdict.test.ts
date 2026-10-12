import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ServiceVerdict } from "../scripts/lib/service-drift.ts";
import {
	watchdogVerdict,
	type HealthState,
} from "../scripts/lib/watchdog-verdict.ts";

function healthy() {
	return {
		activation: {
			name: "activation" as const,
			state: "ok" as HealthState,
			detail: "verified revision",
		},
		services: [
			{
				label: "fixture",
				state: "running" as const,
				reason: "verified unit",
				pid: 1,
			},
		] as ServiceVerdict[],
		progress: {
			name: "progress" as const,
			state: "ok" as HealthState,
			detail: "idle graph",
		},
		lane: {
			name: "lane" as const,
			state: "ok" as HealthState,
			detail: "tool roundtrip passed",
		},
		memory: {
			name: "memory" as const,
			state: "ok" as HealthState,
			detail: "below guards",
		},
	};
}
test("aggregate publishes all dimensions and only verified healthy observations exit zero", () => {
	const result = watchdogVerdict(healthy(), 0);
	expect(result).toMatchObject({
		schema: "fleet.watchdog-verdict.v1",
		state: "ok",
		exitCode: 0,
		at: "1970-01-01T00:00:00.000Z",
	});
	expect(result.dimensions.map((dimension) => dimension.name)).toEqual([
		"activation",
		"services",
		"progress",
		"lane",
		"memory",
	]);
});
test("service failures cannot be hidden by passing activation and inference probes", () => {
	for (const state of [
		"unknown",
		"starting",
		"degraded",
		"drift",
		"unloaded",
		"disabled",
	] as const) {
		const input = healthy();
		input.services[0] = { ...input.services[0], state };
		const result = watchdogVerdict(input);
		expect(result.exitCode).toBe(1);
		expect(result.dimensions[1].detail).toContain(state);
	}
	const input = healthy();
	input.services = [];
	expect(watchdogVerdict(input).state).toBe("unknown");
});
test("missing controller activation provenance is unknown rather than process death", () => {
	const result = watchdogVerdict({
		...healthy(),
		requiredServices: ["com.suspenders.fleet-loop"],
	});
	expect(result.state).toBe("unknown");
	expect(result.exitCode).toBe(1);
	expect(result.dimensions[1].detail).toContain("process death not inferred");
	expect(result.dimensions[1].detail).not.toContain("unloaded");
});

test("idle scheduled services are healthy while graph stalls and unavailable evidence fail", () => {
	const scheduled = healthy();
	scheduled.services[0].state = "scheduled-idle";
	expect(watchdogVerdict(scheduled).exitCode).toBe(0);
	for (const [dimension, state] of [
		["progress", "stalled"],
		["progress", "unknown"],
		["activation", "unknown"],
		["activation", "degraded"],
		["lane", "degraded"],
		["memory", "unknown"],
		["memory", "degraded"],
	] as const) {
		const input = healthy();
		input[dimension].state = state;
		const result = watchdogVerdict(input);
		expect(result.exitCode).toBe(1);
		expect(result.state).toBe(state);
	}
});
test("watchdog stores the typed aggregate and returns its exit code without restart bookkeeping writes", () => {
	const source = readFileSync(
		new URL("../scripts/dispatch-watchdog.ts", import.meta.url),
		"utf8",
	);
	expect(source).toContain("return health.exitCode");
	expect(source).toContain("at: health.at");
	expect(source).toContain("health,");
	expect(source).not.toContain("progressRestarts:");
	expect(source).not.toContain("kickstart");
});
