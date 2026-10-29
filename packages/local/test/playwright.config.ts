// playwright.config.ts — local's package config (W1294.12 sweep-I port).
// The corpus lives in bin/ (one command per local service), so the
// discovery root widens to the whole package. Every default rides the
// central playwright.base.ts (decision.central-configs) — `bun --bun
// playwright test --config=packages/local/test/playwright.config.ts
// --project=unit`.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig({ testDir: ".." });
