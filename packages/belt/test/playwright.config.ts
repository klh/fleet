// test/playwright.config.ts — W1294.1 (ported onto W1294.18.1): belt/test's
// package config. Every default rides the central playwright.base.ts
// (decision.central-configs); zero deltas — this file scopes
// `bun --bun playwright test --config=packages/belt/test/playwright.config.ts
// --project=unit` to the belt/test corpus.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
