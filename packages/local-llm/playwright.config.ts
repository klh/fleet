// playwright.config.ts — local-llm's package config (W1294.12 sweep-I
// port). The corpus sits at the package ROOT (flat runtime-kit layout, no
// test/ dir), so the discovery root is the whole package. Every default
// rides the central playwright.base.ts (decision.central-configs) —
// `bun --bun playwright test --config=packages/local-llm/playwright.config.ts
// --project=unit`.
import { defineFleetConfig } from "../../playwright.base.ts";

export default defineFleetConfig();
