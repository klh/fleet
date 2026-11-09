// test/playwright.config.ts — package config over the one central
// playwright.base.ts default (decision.central-configs); no re-declared
// defaults, testDir widened to the package root.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig({ testDir: ".." });
