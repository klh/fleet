import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "../../test-kit/src/index.ts";
import {
	clearDeferral,
	deferralOf,
	deferItem,
	isDeferredItem,
	requeuePending,
} from "../scripts/lib/dispatch-defers.ts";
test.describe("@unit", () => {
let serial = 0;
const item = () => `fixture-deferral-${++serial}`;
const row = (id: string, owner_sid: unknown, state = "CLAIMED") =>
	JSON.stringify({ id, owner_sid, state });

test("claim failure defers only proven exact-item ownership by another session", () => {
	for (const state of ["CLAIMED", "RUNNING"]) {
		const id = item();
		expect(
			deferItem(id, { code: 0, out: row(id, "peer", state) }, "self"),
		).toBeNull();
		expect(isDeferredItem(id)).toBe(true);
	}
});
test("control-plane failures, malformed rows and uncertain claims remain global holds", () => {
	const cases = [
		{ code: 1, out: "control plane unavailable" },
		{ code: 0, out: "invalid JSON" },
		{ code: 0, out: "null" },
		{ code: 0, out: "[]" },
	];
	for (const evidence of cases) {
		const id = item();
		deferItem(id, evidence, "self");
		expect(isDeferredItem(id)).toBe(false);
	}
	for (const [owner, state] of [
		["peer", "READY"],
		["self", "CLAIMED"],
		["", "CLAIMED"],
		[null, "CLAIMED"],
	] as const) {
		const id = item();
		deferItem(id, { code: 0, out: row(id, owner, state) }, "self");
		expect(isDeferredItem(id)).toBe(false);
	}
	const id = item();
	deferItem(id, { code: 0, out: row("different-item", "peer") }, "self");
	expect(isDeferredItem(id)).toBe(false);
});
test("proven residue deferrals still let refill continue", () => {
	const id = item();
	expect(deferItem(id)).toBeNull();
	expect(isDeferredItem(id)).toBe(true);
});
});

test.describe("@unit W2315 requeueAt backoff", () => {
	const fleet = scratchWorld();
	test.afterAll(() => fleet.clean());
	const fleetDir = join(fleet.repo, ".fleet");

	test("deferral stamps requeueAt on the ladder; refill skips until expiry", () => {
		const id = "fixture-requeue-1";
		const before = Date.now();
		expect(requeuePending(fleetDir, id, before)).toBe(false);
		deferItem(id, undefined, undefined, fleetDir);
		const rec = deferralOf(fleetDir, id, before);
		expect(rec?.failures).toBe(1);
		expect(rec?.requeueAt).toBeGreaterThanOrEqual(before + 5_000);
		expect(requeuePending(fleetDir, id, before)).toBe(true);
		// expired requeueAt → refill-eligible again
		expect(requeuePending(fleetDir, id, (rec?.requeueAt ?? 0) + 1)).toBe(
			false,
		);
	});

	test("repeated deferrals climb the ladder; clearDeferral retires the backoff", () => {
		const id = "fixture-requeue-2";
		deferItem(id, undefined, undefined, fleetDir);
		const t2 = deferralOf(fleetDir, id)?.requeueAt ?? 0;
		deferItem(id, undefined, undefined, fleetDir);
		const rec = deferralOf(fleetDir, id);
		expect(rec?.failures).toBe(2);
		expect(rec?.requeueAt).toBeGreaterThanOrEqual(t2 + 5_000);
		clearDeferral(fleetDir, id);
		expect(deferralOf(fleetDir, id)).toBeNull();
	});

	test("ladder caps at the last step; junk file fails open", () => {
		const id = "fixture-requeue-3";
		for (let i = 0; i < 8; i++) deferItem(id, undefined, undefined, fleetDir);
		const rec = deferralOf(fleetDir, id);
		expect(rec?.failures).toBe(8);
		expect((rec?.requeueAt ?? 0) - Date.now()).toBeLessThanOrEqual(56_000);
		// junk file: the read fails open, the next record rebuilds cleanly
		writeFileSync(join(fleetDir, "dispatch-defers.json"), "not json");
		expect(deferralOf(fleetDir, id)).toBeNull();
		deferItem(id, undefined, undefined, fleetDir);
		expect(deferralOf(fleetDir, id)?.failures).toBe(1);
	});

	test("run-local deferrals (no fleetDir) stay out of the persisted file", () => {
		const id = "fixture-requeue-4";
		deferItem(id);
		expect(deferralOf(fleetDir, id)).toBeNull();
	});
});
