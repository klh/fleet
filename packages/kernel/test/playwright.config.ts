// test/playwright.config.ts — kernel/test's package config (W2279 port).
// Self-contained local config (the tests/ + buckle/test W1303.1.7 shape):
// kernel imports nothing in fleet, so the repo-root playwright.base.ts
// builder is out of reach — the defaults below mirror defineFleetConfig's
// zero-delta body; the unit project scopes `bun --bun playwright test
// --config=packages/kernel/test/playwright.config.ts --project=unit` to
// the kernel/test corpus.
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
