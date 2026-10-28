// test/playwright.config.ts — blam/test's package config (W840 port). Every
// default rides the central playwright.base.ts (decision.central-configs);
// zero deltas — `bun --bun playwright test
// --config=packages/blam/test/playwright.config.ts --project=unit`.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
