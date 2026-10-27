import { expect, test } from "@playwright/test";
import {
	deliverWatchdogDecision,
	recoverWatchdogDecision,
} from "../scripts/lib/watchdog-decision.ts";

const HOUR = 60 * 60 * 1000;

test("failed coord delivery remains eligible on the next pass", () => {
	const deliveredAt: Record<string, number> = {};
	let attempts = 0;
	const deliver = (): boolean => ++attempts === 2;
	expect(
		deliverWatchdogDecision(
			deliveredAt,
			"memory-wired-guard",
			"guard",
			1_000,
			6 * HOUR,
			deliver,
		),
	).toBe(false);
	expect(deliveredAt).toEqual({});
	expect(
		deliverWatchdogDecision(
			deliveredAt,
			"memory-wired-guard",
			"guard",
			301_000,
			6 * HOUR,
			deliver,
		),
	).toBe(true);
	expect(deliveredAt["memory-wired-guard"]).toBe(301_000);
	expect(attempts).toBe(2);
});

test("recovery re-arms a new memory incident while one incident stays throttled", () => {
	const deliveredAt: Record<string, number> = {};
	let attempts = 0;
	const deliver = (): boolean => {
		attempts++;
		return true;
	};
	expect(
		deliverWatchdogDecision(
			deliveredAt,
			"memory-cloud-gateway",
			"first incident",
			1_000,
			6 * HOUR,
			deliver,
		),
	).toBe(true);
	expect(
		deliverWatchdogDecision(
			deliveredAt,
			"memory-cloud-gateway",
			"same incident",
			301_000,
			6 * HOUR,
			deliver,
		),
	).toBe(false);
	expect(attempts).toBe(1);
	recoverWatchdogDecision(deliveredAt, "memory-cloud-gateway");
	expect(
		deliverWatchdogDecision(
			deliveredAt,
			"memory-cloud-gateway",
			"new incident",
			601_000,
			6 * HOUR,
			deliver,
		),
	).toBe(true);
	expect(attempts).toBe(2);
});
