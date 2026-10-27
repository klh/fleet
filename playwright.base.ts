// playwright.base.ts — the ONE playwright config source of truth
// (W1294.18.1 repair, decision.central-configs: a default declared here
// reaches every package; per-package playwright.config.ts files import
// defineFleetConfig and pass deltas only — never re-declared defaults).
// Projects: @unit (default, the migrated corpus) + @smoke. Run with
// `bun --bun playwright test --project=unit` from repo root.
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

export type FleetConfigDeltas = Partial<PlaywrightTestConfig>;

export const defineFleetConfig = (deltas: FleetConfigDeltas = {}) =>
	defineConfig({
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
		...deltas,
	});
