// playwright.config.ts — speedy's package config (W1294.12 sweep-I port).
// Every default rides the central playwright.base.ts
// (decision.central-configs) — `bun --bun playwright test
// --config=packages/speedy/test/playwright.config.ts --project=unit`.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
