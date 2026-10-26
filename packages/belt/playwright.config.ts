// W1294.7: the belt/test corpus as playwright specs. Local stopgap config —
// the canonical defineFleetConfig builder lands with W1294.1; this file only
// names the unit project so `bun --bun playwright test --project=unit`
// finds the test/ specs from repo root.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "test",
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
