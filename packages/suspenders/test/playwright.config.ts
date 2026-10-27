// test/playwright.config.ts — W2173.5.1: runner config for the ported
// suspenders unit corpus (test/*.e2e.ts). Standalone defineConfig for now;
// converts to extends over the canonical playwright.base.ts builder when
// W2173.5.3 lands. Serial single-worker like the other fleet suites; the
// bun runtime (--bun) is required — 287 of the corpus files use Bun.*
// globals (spawn, tmpdir, password).
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	timeout: 30_000,
	expect: { timeout: 5_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: "test-results",
	projects: [{ name: "unit", testMatch: "*.e2e.ts" }],
});
