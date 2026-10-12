// pure governance decisions: probe/lane-key (W422.17) + hub attribution

import { describe, expect, test } from "bun:test";
import { hubAttributionDecision, laneKeyDecision, parseGovernanceMode, probeFrontDecision } from "../../scripts/dispatch-next.ts";

// ─── governance mode (W422.17, owner ruling 2026-10-06) ──────────────────
describe("governance mode decisions (W422.17)", () => {
	test("probeFrontDecision: strict refuses, citing front + governance:strict", () => {
		const d = probeFrontDecision(false, "strict");
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse")
			expect(d.why).toContain("buckle front unreachable + governance:strict");
	});

	test("probeFrontDecision: solo proceeds belt-direct with the loud note", () => {
		const d = probeFrontDecision(false, "solo");
		expect(d.mode).toBe("belt-direct");
		if (d.mode === "belt-direct") expect(d.note).toContain("governance:solo");
	});

	test("probeFrontDecision: --allow-ungoverned overrides BOTH modes", () => {
		for (const m of ["strict", "solo"] as const) {
			expect(probeFrontDecision(true, m).mode).toBe("ungoverned-override");
		}
	});

	test("parseGovernanceMode: unset/strict/garbage → strict; solo → solo", () => {
		expect(parseGovernanceMode("(unset)")).toBe("strict");
		expect(parseGovernanceMode("solo (v3)")).toBe("solo");
		expect(parseGovernanceMode("strict (v1)")).toBe("strict");
		expect(parseGovernanceMode("wibble (v9)")).toBe("strict");
	});

	test("laneKeyDecision: solo does NOT relent at mint failures (W463 stands)", () => {
		expect(laneKeyDecision(null, false, "solo").mode).toBe("refuse");
	});
});

// ─── hub-won attribution decisions (W615) ─────────────────────────────────
describe("hubAttributionDecision (W615)", () => {
	test("minted → governed: the hub's own scoped key attributes the lane", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: { key: "bksk_hub", keyId: "hubkey123456" },
			allowUngoverned: false,
		});
		expect(d).toEqual({
			mode: "governed",
			key: "bksk_hub",
			keyId: "hubkey123456",
		});
	});

	test("no hub credential → refuse, naming both credential surfaces", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") {
			expect(d.why).toContain("SUSPENDERS_HUB_<LABEL>_TOKEN");
			expect(d.why).toContain("hubs.json token");
		}
	});

	test("mint failure (credential present) → refuse (W463 stands at hubs too)", () => {
		const d = hubAttributionDecision({
			hasToken: true,
			minted: null,
			allowUngoverned: false,
		});
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse") expect(d.why).toContain("mint failed");
	});

	test("--allow-ungoverned keeps the hub pin: rides the hub UNATTRIBUTED", () => {
		const d = hubAttributionDecision({
			hasToken: false,
			minted: null,
			allowUngoverned: true,
		});
		expect(d.mode).toBe("ungoverned-override");
		if (d.mode === "ungoverned-override")
			expect(d.note).toContain("rides the hub unattributed");
	});
});

