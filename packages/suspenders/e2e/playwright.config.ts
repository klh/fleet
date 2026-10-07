// e2e/playwright.config.ts — W353: the hub-board GUI e2e config. Serial
// single-worker: the spec drives ONE hub board + ONE local board through a
// stateful lifecycle (declare → reconcile → done), so tests share the
// boards via beforeAll and run in file order. Browsers resolve from the
// machine cache (~/Library/Caches/ms-playwright) — never a CDN fetch.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	workers: 1,
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: "test-results",
	use: {
		headless: true,
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
	},
});
