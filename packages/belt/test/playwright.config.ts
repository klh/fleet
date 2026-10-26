// test/playwright.config.ts — W1294.1: belt's package config. The
// defineFleetConfig builder (@klh/suspenders test helpers) owns projects,
// tags and the smoke dependency chain; belt adds no deltas.
import { defineFleetConfig } from "@klh/suspenders/test/helpers/testing-kit.ts";

export default defineFleetConfig({ testDir: import.meta.dir });
