// tests/playwright.base.ts — W2173.5.3: the canonical defineFleetConfig
// builder (the W1294.1 face). Every fleet playwright config extends THIS;
// standalone defineConfig calls in the repo are ratcheted to zero by
// tests/config-centralization.e2e.ts. Fleet defaults (workers 1,
// fullyParallel false, retries 0, list reporter, headless + fixed
// viewport, trace retain-on-failure) are owned here once; importing
// configs pass only their deltas. Relative paths (testDir, outputDir)
// resolve against the importing config's own directory.
import { defineConfig } from "@playwright/test";

export type FleetConfigInput = {
	/** Spec directory, relative to the importing config file. */
	testDir: string;
	/** Spec glob — default "*.e2e.ts". */
	testMatch?: string;
	/** Per-test timeout ms — default 60_000. */
	timeout?: number;
	/** expect() timeout ms — default 5_000. */
	expectTimeout?: number;
	/** Playwright projects — default none (single unnamed project). */
	projects?: Array<{ name: string; testMatch: string | RegExp }>;
};

export function defineFleetConfig(input: FleetConfigInput): Config {
	const {
		testDir,
		testMatch = "*.e2e.ts",
		timeout = 60_000,
		expectTimeout = 5_000,
		projects,
	} = input;
	return defineConfig({
		testDir,
		testMatch,
		timeout,
		expect: { timeout: expectTimeout },
		workers: 1,
		fullyParallel: false,
		retries: 0,
		reporter: [["list"]],
		outputDir: "test-results",
		...(projects ? { projects } : {}),
		use: {
			headless: true,
			viewport: { width: 1440, height: 900 },
			trace: "retain-on-failure",
		},
	});
}
