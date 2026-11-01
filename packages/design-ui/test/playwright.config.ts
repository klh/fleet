// test/playwright.config.ts — W2269.1.1: design-ui's package config. Every
// default rides the central playwright.base.ts (decision.central-configs);
// zero deltas — this file scopes
// `bun --bun playwright test --config=packages/design-ui/test/playwright.config.ts`
// to the design-ui/test corpus.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
