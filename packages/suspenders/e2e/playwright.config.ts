// e2e/playwright.config.ts — W353: the hub-board GUI e2e config. Serial
// single-worker: the spec drives ONE hub board + ONE local board through a
// stateful lifecycle (declare → reconcile → done), so tests share the
// boards via beforeAll and run in file order. W2173.5.3: extends the
// canonical defineFleetConfig builder (tests/playwright.base.ts) —
// deltas only, no standalone defineConfig. Browsers resolve from the
// machine cache (~/Library/Caches/ms-playwright) — never a CDN fetch.
import { defineFleetConfig } from "../../../tests/playwright.base.ts";

export default defineFleetConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	expectTimeout: 15_000,
});
