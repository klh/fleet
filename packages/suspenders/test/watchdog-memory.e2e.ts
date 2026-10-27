import { expect, test } from "@playwright/test";
import {
	coldLoadTimeoutMs,
	wiredGuardGb,
} from "../../local-llm/memory-policy.ts";
import {
	emergencyWiredLimitGb,
	loadingReservation,
} from "../scripts/lib/watchdog-memory.ts";

test("watchdog emergency limit follows Belt's validated admission guard", () => {
	expect(wiredGuardGb("90")).toBe(90);
	expect(emergencyWiredLimitGb("90")).toBe(94);
	expect(emergencyWiredLimitGb("garbage")).toBe(64);
	expect(wiredGuardGb("")).toBe(60);
});

test("a matching live cold reservation is exempt only for its bounded load window", () => {
	const now = 1_000_000;
	const rows = { "8903": { pid: 42, startedAt: now - 10_000, ram_gb: 31 } };
	expect(coldLoadTimeoutMs(22)).toBe(440_000);
	expect(loadingReservation(8903, 42, rows, now)).toBe(true);
	expect(loadingReservation(8903, 43, rows, now)).toBe(false);
	expect(loadingReservation(8903, 42, rows, now + 490_000)).toBe(false);
	expect(loadingReservation(8906, 42, rows, now)).toBe(false);
});
