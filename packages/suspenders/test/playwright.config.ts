// test/playwright.config.ts — W1294.1 (ported onto W1294.18.1): suspenders'
// package config. Every default rides the central playwright.base.ts
// (decision.central-configs). One delta (W1294.5): the discovery root is the
// whole package — the sweep co-situates unit specs beside their
// scripts/deploy/hooks sources, not under test/. The board GUI *.spec.ts
// corpus keeps its own chromium config in packages/suspenders/e2e/.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig({ testDir: ".." });
