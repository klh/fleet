// tests/playwright.config.ts — W1303.1.7: the root tests/ e2e config for
// the package-contract guard specs (check-deps.e2e.ts and siblings).
// W2173.5.3: extends the canonical defineFleetConfig builder
// (tests/playwright.base.ts) — deltas only, no standalone defineConfig.
import { defineFleetConfig } from "./playwright.base.ts";

export default defineFleetConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	projects: [{ name: "api", testMatch: "*.e2e.ts" }],
});
