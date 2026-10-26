// W1294.18.1: the bench corpus as playwright specs — extends the central
// base (decision.central-configs): every default rides playwright.base.ts
// (testDir resolves to this file's dir, the unit project, 60s timeout,
// workers 1, list reporter). Zero deltas — this file exists so
// `bun --bun playwright test --config=packages/belt/bench/playwright.config.ts
// --project=unit` scopes the run to the bench corpus from repo root.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
