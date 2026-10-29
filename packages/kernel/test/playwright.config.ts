// test/playwright.config.ts — kernel/test's package config (W1294.12
// sweep-I port). Every default rides the central playwright.base.ts
// (decision.central-configs); zero deltas — `bun --bun playwright test
// --config=packages/kernel/test/playwright.config.ts --project=unit`.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
