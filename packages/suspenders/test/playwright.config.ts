// test/playwright.config.ts — W1294.1: suspenders' package config. The
// defineFleetConfig builder (test/helpers/testing-kit.ts) owns projects,
// tags and the smoke dependency chain; this file adds package deltas only —
// the board GUI *.spec.ts corpus needs the chromium browser.
import { defineFleetConfig } from "./helpers/testing-kit.ts";

export default defineFleetConfig({
	testDir: import.meta.dir,
	testMatch: ["**/*.e2e.ts", "**/*.spec.ts"],
});
