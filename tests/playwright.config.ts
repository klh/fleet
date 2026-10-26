// W1303.1.9: local config for the root tests/ *.e2e.ts family (buckle
// sweep-G interim shape). The canonical defineFleetConfig builder lands
// with W1294.1/W1294.18.1 — consolidate this onto playwright.base.ts at
// that merge. Names the api project only; browserless specs.
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
