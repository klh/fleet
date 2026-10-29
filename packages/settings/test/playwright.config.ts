// W1294: settings unit families as playwright specs. Local config — same
// shape as buckle's local config (project=unit, list reporter, workers 1 —
// the specs swap process.env/stderr in-process and must not race).
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
