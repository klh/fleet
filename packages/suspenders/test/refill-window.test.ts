import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canAttemptRefill,
	dispatchHeld,
	plaidCycleOpen,
	plaidLaunchGapMs,
	refillWindow,
} from "../scripts/lib/refill-window.ts";

test("plaid keeps growing regardless of total live lanes or launches this cycle", () => {
	for (const live of [0, 18, 40, 400]) {
		const window = refillWindow("plaid", 6, live, 0);
		expect(window.target).toBeNull();
		expect(canAttemptRefill(window, live)).toBe(true);
		expect(canAttemptRefill(window, live + 40)).toBe(true);
	}
});

test("plaid pauses new attempts during observed rate-limit pressure", () => {
	const window = refillWindow("plaid", 6, 40, 2);
	expect(canAttemptRefill(window, 40)).toBe(false);
});

test("Plaid launch gap validates operator setting and keeps a safe floor", () => {
	expect(plaidLaunchGapMs()).toBe(10_000);
	expect(plaidLaunchGapMs("15000")).toBe(15_000);
	expect(plaidLaunchGapMs("1")).toBe(10_000);
	expect(plaidLaunchGapMs("junk")).toBe(10_000);
});

test("Plaid returns control before the supervisor cycle watchdog", () => {
	expect(plaidCycleOpen(1_000, 1_000 + 11 * 60_000)).toBe(true);
	expect(plaidCycleOpen(1_000, 1_000 + 12 * 60_000)).toBe(false);
});

test("dispatch hold marker gates new launches without changing posture", () => {
	const dir = mkdtempSync(join(tmpdir(), "plaid-hold-"));
	try {
		expect(dispatchHeld(dir)).toBe(false);
		writeFileSync(join(dir, "dispatch-paused"), "hub rollout\n");
		expect(dispatchHeld(dir)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("steady target and rate-limit pacing retain numeric target", () => {
	const normal = refillWindow("steady", 6, 4, 0);
	expect(normal.target).toBe(6);
	expect(canAttemptRefill(normal, 5)).toBe(true);
	expect(canAttemptRefill(normal, 6)).toBe(false);
	const paced = refillWindow("steady", 6, 4, 2);
	expect(paced.target).toBe(4);
});
