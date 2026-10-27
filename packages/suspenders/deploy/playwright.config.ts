// deploy/playwright.config.ts — W1711 (ported onto W1294.18.1): the deploy/
// e2e config for the hub catalog reconciliation spec (hub-catalog.e2e.ts).
// Every default rides the central playwright.base.ts
// (decision.central-configs); zero deltas. Run:
//   bunx playwright test --config packages/suspenders/deploy/playwright.config.ts
import { defineFleetConfig } from "../../../playwright.base.ts";

export default defineFleetConfig();
