// W1294.16: the buckle/test sweep-G ports as playwright specs. Local config —
// the canonical defineFleetConfig builder lands with W1294.1; this file only
// names the api project so `bun --bun playwright test --project=api` finds
// the family from this directory. sweep-G family is uniformly @api.
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
	projects: [{ name: "api", testMatch: "*.e2e.ts" }],
});
