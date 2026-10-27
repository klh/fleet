// test/playwright.config.ts — W1294.1 (ported onto W1294.18.1): suspenders/
// test's package config for the *.e2e.ts corpus (posture, review-quota, the
// ported sweeps). Every default rides the central playwright.base.ts
// (decision.central-configs); the board GUI *.spec.ts corpus keeps its own
// chromium config in packages/suspenders/e2e/.
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
