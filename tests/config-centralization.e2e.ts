// tests/config-centralization.e2e.ts — W2173.5.3: guards the ONE
// playwright config builder. Standalone defineConfig calls outside
// tests/playwright.base.ts are the regression this spec ratchets to zero;
// configs must extend defineFleetConfig instead. Helpers live in
// tests/helpers/config-centralization.ts per the spec shape law.
import { expect, test } from "@playwright/test";
import { defineFleetConfig } from "./playwright.base.ts";
import { scanStandaloneConfigs } from "./helpers/config-centralization.ts";

test.describe("@unit", () => {
	test("no standalone defineConfig outside the canonical builder", () => {
		expect(scanStandaloneConfigs(process.cwd())).toEqual([]);
	});

	test("defineFleetConfig pins the fleet defaults", () => {
		const config = defineFleetConfig({ testDir: "." });
		expect(config.workers).toBe(1);
		expect(config.fullyParallel).toBe(false);
		expect(config.retries).toBe(0);
		expect(config.timeout).toBe(60_000);
		expect(config.expect?.timeout).toBe(5_000);
		expect(config.reporter).toEqual([["list"]]);
	});
});
