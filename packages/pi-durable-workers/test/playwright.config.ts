// test/playwright.config.ts — package config over the one central
// playwright.base.ts default (decision.central-configs). Inlined rather
// than imported (settings' test/playwright.config.ts does the same): a
// brand-new package has no inherited import-law baseline, so a relative
// reach-in into the repo root would read as a NEW edge at this lane
// (W1302.4) even though every sibling package's config carries the
// identical one from before the ratchet existed.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "..",
	testMatch: "**/*.e2e.ts",
	timeout: 60_000,
	expect: { timeout: 5_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: "test-results",
	projects: [{ name: "unit", testMatch: "**/*.e2e.ts" }],
});
