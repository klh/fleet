import { expect, test } from "bun:test";
import { deferItem, isDeferredItem } from "../scripts/lib/dispatch-defers.ts";
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
