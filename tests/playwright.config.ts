// tests/playwright.config.ts — W1303.1.7: the root tests/ e2e config for
// the package-contract guard specs (check-deps.e2e.ts and siblings).
// Mirrors the buckle/test sweep-G shape (W1294.16): local file until the
// canonical defineFleetConfig builder (playwright.base.ts, W1294.18.1)
// merges — then this converts to extends-only zero deltas.
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
