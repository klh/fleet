import { describe, expect, test } from "bun:test";
import { endpointState, supervisorFresh } from "../bin/dashboard-state.ts";
import type { StatusDoc, TargetStatus } from "../bin/supervisor.ts";

const now = Date.parse("2026-10-06T06:00:00Z");
const target: TargetStatus = {
	name: "code",
	port: 8901,
	kind: "ondemand",
	owned: false,
	state: "idle",
	alert: false,
	since: "",
	lastProbe: null,
	lastOk: null,
	restarts: 0,
	restartsLastWindow: 0,
	pid: null,
	nextRetryAt: null,
	lastError: null,
};
const doc: StatusDoc = {
	version: 1,
	supervisorPid: 1,
	updated: new Date(now).toISOString(),
	intervalMs: 5000,
	targets: [target],
};

describe("dashboard observability", () => {
	test("on-demand absence is idle rather than a failure", () => {
		expect(endpointState(false, target, doc, now)).toBe("idle · on demand");
	});
	test("a stale snapshot never establishes current supervisor state", () => {
		expect(supervisorFresh(doc, now + 15_001)).toBe(false);
		expect(endpointState(false, target, doc, now + 15_001)).toBe(
			"not listening",
		);
		expect(endpointState(true, target, null, now)).toBe("listening");
		expect(supervisorFresh({ ...doc, updated: "invalid" }, now)).toBe(false);
		expect(
			supervisorFresh(
				{ ...doc, updated: new Date(now + 60_000).toISOString() },
				now,
			),
		).toBe(false);
	});
	test("dependency blocks and exhausted budgets have distinct actionable states", () => {
		expect(
			endpointState(
				false,
				{ ...target, preflightError: "missing dependency" },
				doc,
				now,
			),
		).toBe("dependency blocked");
		expect(
			endpointState(false, { ...target, state: "unhealthy" }, doc, now),
		).toBe("restart limit reached");
		expect(
			endpointState(false, { ...target, state: "backoff" }, doc, now),
		).toBe("retry scheduled");
	});
	test("disagreement does not silently paint an endpoint ready", () => {
		expect(endpointState(false, { ...target, state: "up" }, doc, now)).toBe(
			"probe disagreement",
		);
		expect(endpointState(true, { ...target, state: "up" }, doc, now)).toBe(
			"ready",
		);
	});
});
