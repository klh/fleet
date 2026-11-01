// test/retired-services.e2e.ts — W2339: the watchdog's audit universe tracks
// the CURRENT supervision model, not the activation receipt's history. The
// receipt deliberately retains entries a later manifest retired
// (retainActivation), so without reconciliation the watchdog re-cards
// "recorded unit unavailable" for every W779-folded label on each 5-minute
// pass (13 NEED_DECISIONs, 2026-10-31).
import { test, expect } from "@playwright/test";
import {
	retiredServiceLabels,
	splitRetiredVerdicts,
} from "../scripts/lib/retired-services.ts";
import type { ServiceVerdict } from "../scripts/lib/service-drift.ts";
import { MAINTENANCE_TASKS } from "../hooks/lib/fleet-loop/maintenance.ts";
import { loadLegacyLabels } from "../scripts/install/install-services.ts";

test.describe("@unit retired-services (W2339)", () => {
	test("every W779 heartbeat task retires its launchd label", () => {
		const retired = retiredServiceLabels();
		for (const task of MAINTENANCE_TASKS)
			expect(
				retired.has(`com.suspenders.${task.name}`),
				`${task.name} must drop out of the watchdog audit`,
			).toBe(true);
	});

	test("manifest legacyLabels retire too — including the W695.6 ikea-shim boot-out gap", () => {
		const retired = retiredServiceLabels();
		for (const label of loadLegacyLabels())
			expect(retired.has(label), `${label} must drop out`).toBe(true);
		expect(retired.has("com.suspenders.ikea-shim")).toBe(true);
	});

	test("live manifest services stay audited", () => {
		const retired = retiredServiceLabels();
		// fleet-pulse + claude-insights are LIVE units — their drift is real
		for (const label of [
			"com.suspenders.fleet-pulse",
			"com.suspenders.claude-insights",
			"com.suspenders.board",
			"com.suspenders.fleet-loop",
		])
			expect(retired.has(label), `${label} is live — must stay audited`).toBe(
				false,
			);
	});

	test("splitRetiredVerdicts separates ghosts, preserves audit order", () => {
		const retired = retiredServiceLabels();
		const verdicts: ServiceVerdict[] = [
			{
				label: "com.suspenders.board",
				state: "running",
				reason: "ok",
				pid: 1,
			},
			{
				label: "com.suspenders.fleet-monitor",
				state: "unknown",
				reason: "recorded unit unavailable",
				pid: null,
			},
			{
				label: "com.suspenders.fleet-pulse",
				state: "degraded",
				reason: "scheduled invocation failed with exit code 1",
				pid: null,
			},
			{
				label: "com.suspenders.ikea-shim",
				state: "unknown",
				reason: "recorded unit unavailable",
				pid: null,
			},
		];
		const { audited, retiredGhosts } = splitRetiredVerdicts(verdicts, retired);
		expect(audited.map((v) => v.label)).toEqual([
			"com.suspenders.board",
			"com.suspenders.fleet-pulse",
		]);
		expect(retiredGhosts.map((v) => v.label)).toEqual([
			"com.suspenders.fleet-monitor",
			"com.suspenders.ikea-shim",
		]);
	});

	test("an unreadable manifest degrades to the task-derived set, never empty", () => {
		const retired = retiredServiceLabels("/nonexistent/services.yaml");
		expect(retired.size).toBe(MAINTENANCE_TASKS.length);
		expect(retired.has("com.suspenders.fleet-monitor")).toBe(true);
	});

	test("undefined manifest path (no activated generation) falls back to the repo manifest", () => {
		const retired = retiredServiceLabels(undefined);
		expect(retired.has("com.suspenders.ikea-shim")).toBe(true);
	});
});
