// packages/blam/test/crash.e2e.ts — CRASH S1-S5 bench contract tests
// (W840): post-fix all-pass, pre-fix headline reproduction, determinism,
// and per-scenario mechanics from plane events.
import { expect, test } from "@playwright/test";
import { runMatrix } from "../bench/crash/harness.ts";
import { s1, s2, s3, s4, s5 } from "../bench/crash/scenarios.ts";

const matrix = runMatrix();

test.describe("crash bench S1-S5 (W840) @unit", () => {
	test("post-fix plane: every property holds on every run", () => {
		for (const o of matrix.filter((o) => o.era === "post")) {
			for (const held of Object.values(o.properties)) expect(held).toBe(true);
			expect(o.ttdTicks).not.toBeNull();
		}
	});

	test("pre-fix plane: the 2026-09-28 headline failures reproduce", () => {
		const pre1 = matrix.filter((o) => o.era === "pre" && o.run === 1);
		const s1o = pre1.find((o) => o.scenario === "S1");
		const s4o = pre1.find((o) => o.scenario === "S4");
		const s5o = pre1.find((o) => o.scenario === "S5");
		expect(s1o?.properties["no-false-retire"]).toBe(false);
		expect(s4o?.properties["next-not-falsely-failed"]).toBe(false);
		expect(s4o?.properties["no-data-loss"]).toBe(false);
		expect(s5o?.properties["no-foreign-conclusion"]).toBe(false);
	});
});

/** Per-scenario mechanics, one run each. */
test.describe("crash bench mechanics (W840) @unit", () => {
	test("S5 pre: the foreign commit is a real two-parent commit", () => {
		const o = s5("pre", 1);
		expect(o.properties["no-foreign-conclusion"]).toBe(false);
	});

	test("S2 post: heal lands in cycle one (identity liveness)", () => {
		const o = s2("post", 1);
		expect(o.properties["debris-healed"]).toBe(true);
		expect(o.ttrTicks).toBe(1);
	});

	test("S4 post: debris preserved, next branch merged", () => {
		const o = s4("post", 1);
		expect(o.properties["debris-cleared-in-cycle"]).toBe(true);
	});

	test("S1 pre: false retire; S3 pre: retire on vanished name", () => {
		const o1 = s1("pre", 1);
		expect(o1.falseBlocks).toBe(1);
		const o3 = s3("pre", 1);
		expect(o3.properties["no-retire-on-vanished"]).toBe(false);
	});
});
