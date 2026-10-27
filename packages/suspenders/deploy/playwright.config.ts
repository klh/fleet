// deploy/playwright.config.ts — W1711: the deploy/ e2e config for the
// hub catalog reconciliation spec (hub-catalog.e2e.ts). Mirrors the root
// tests/ shape (W1303.1.7): local file until the canonical defineFleetConfig
// builder (playwright.base.ts, W1294.18.1) merges — then this converts to
// extends-only zero deltas. Output rides the OS tmpdir so a run never
// dirties the checkout. Run:
//   bun --cwd packages/suspenders playwright test --config deploy/playwright.config.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	outputDir: join(tmpdir(), "klh-deploy-e2e-results"),
	projects: [{ name: "unit", testMatch: "*.e2e.ts" }],
});
