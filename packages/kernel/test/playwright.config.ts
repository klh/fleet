// test/playwright.config.ts — kernel/test's package config (W2279 port).
// Every default rides the central playwright.base.ts (decision.central-configs);
// zero deltas — this file scopes `bun --bun playwright test
// --config=packages/kernel/test/playwright.config.ts --project=unit` to the
// kernel/test corpus.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
