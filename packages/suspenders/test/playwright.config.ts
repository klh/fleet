// test/playwright.config.ts — W1294.1 (ported onto W1294.18.1): suspenders'
// package config. Every default rides the central playwright.base.ts
// (decision.central-configs). One delta (W1294.5): the discovery root is the
// whole package — the sweep co-situates unit specs beside their
// scripts/deploy/hooks sources, not under test/. The board GUI *.spec.ts
// corpus keeps its own chromium config in packages/suspenders/e2e/.
// W2267.3: browser specs named *.e2e.ts (board-recovery-actions) ride THIS
// config too — headless chromium launches per worker through the shared
// fixtures; the e2e/*.spec.ts corpus keeps its viewport-matrix config.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig({ testDir: ".." });
