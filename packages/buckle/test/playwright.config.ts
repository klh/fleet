// test/playwright.config.ts — W1294.1: buckle's package config. The
// defineFleetConfig builder (@klh/suspenders test helpers) owns projects,
// tags and the smoke dependency chain; buckle adds no deltas. (Replaces
// the sweep-H local shape — same project name, so `--project=unit` and
// `--project=smoke` selectors stay stable.)
import { defineFleetConfig } from "@klh/suspenders/test/helpers/testing-kit.ts";

export default defineFleetConfig({ testDir: import.meta.dir });
