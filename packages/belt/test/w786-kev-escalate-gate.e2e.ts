// W786 — kev escalate-gate: the pure veto predicate rides router-core (no
// serve imports), so the test is table-driven over label × kev answer with
// zero stub servers — the cloud gate itself is the one-line call site in
// router-shim.ts.
import { expect, test } from "@playwright/test";
import { kevEscalateVeto } from "../bin/router-core.ts";

test.describe("kevEscalateVeto (W786)", () => {
	test("vetoes only cloud-labeled requests answered local_adequate @unit", () => {
		expect(kevEscalateVeto("cloud", "local_adequate")).toBe(true);
	});
	test("fail-open on every other input @unit", () => {
		expect(kevEscalateVeto("cloud", "cloud_worthy")).toBe(false);
		expect(kevEscalateVeto("cloud", undefined)).toBe(false);
		expect(kevEscalateVeto("cloud", "")).toBe(false);
		expect(kevEscalateVeto("reason", "local_adequate")).toBe(false);
		expect(kevEscalateVeto("extract", "local_adequate")).toBe(false);
		expect(kevEscalateVeto("none", "local_adequate")).toBe(false);
	});
});
