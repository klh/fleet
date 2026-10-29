// e2e/playwright.config.ts — W1136: the e2e config after the fixture
// upgrade. Boards are per-worker (the fixtures.ts `board` fixture from the
// ONE shared harness) — webServer stays out. Two projects drive the
// viewport matrix: chromium-desktop runs everything at 1440×900,
// chromium-narrow re-runs the two viewport-bound specs at 420×800, so the
// manual setViewportSize calls retire from the specs. Shared pre-flight
// (chromium warm + vendor check) lives in global-setup.ts. Browsers
// resolve from the machine cache — never a CDN fetch.
import { defineConfig } from "@playwright/test";

export default defineConfig({
	globalSetup: "./global-setup.ts",
	testDir: ".",
	testMatch: "*.spec.ts",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	// file-level parallelism: tests within a file stay ordered in one
	// worker; different files (and the two projects) ride different workers.
	// SUSPENDERS_E2E_WORKERS overrides the worker count.
	workers: Number(process.env.SUSPENDERS_E2E_WORKERS ?? 4),
	fullyParallel: false,
	retries: 0,
	reporter: [["list"]],
	outputDir: "test-results",
	use: {
		headless: true,
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "chromium-desktop" },
		{
			name: "chromium-narrow",
			// only the viewport-bound specs re-run on the narrow project
			testMatch: /board-(kanban-column-order|status-badge)\.spec\.ts/,
			use: { viewport: { width: 420, height: 800 } },
		},
	],
});
