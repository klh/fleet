// W1294.17: buckle/test unit families as playwright specs. Local config —
// the canonical defineFleetConfig builder lands with W1294.1; this file only
// names the unit project so `bun --bun playwright test --project=unit` finds
// the specs from packages/buckle/test.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	timeout: 60_000,
	expect: { timeout: 5_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: "test-results",
	projects: [{ name: "unit", testMatch: "*.e2e.ts" }],
});
