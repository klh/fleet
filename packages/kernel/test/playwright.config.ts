// test/playwright.config.ts — kernel/test's package config (W1294.12
// sweep-I port). kernel imports NOTHING in fleet (absolute law, not a
// ratchet) — so this config cannot ride the central playwright.base.ts
// builder like the other packages; it declares the same defaults inline.
// `bun --bun playwright test
// --config=packages/kernel/test/playwright.config.ts --project=unit`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
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
