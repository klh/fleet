// e2e/global-setup.ts — W1136: the shared pre-flight, once per run. Builds
// nothing globally (boards are per-worker by design — webServer stays out),
// it only warms + verifies what every spec assumes:
//
//   1. chromium-launch check — launch + close a real chromium so a missing
//      browser binary fails fast here, with one clear error, instead of as
//      N per-spec launch failures; also warms the binary the OS way.
//   2. vendor warm check — the board pages fetch /vendor/* bundles from
//      hooks/board-html/vendor (no vite in this stack: the vendor bundles
//      ARE the client cache); verify the bundle set is present.
import { chromium } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalSetup(): Promise<void> {
	// 1. chromium-launch check (warm + fail-fast)
	const browser = await chromium.launch();
	await browser.close();

	// 2. vendor warm check — the /vendor bundle set must exist
	// (fileURLToPath: the Playwright runner executes this under Node, where
	// the Bun-ism import.meta.dir is undefined)
	const here = dirname(fileURLToPath(import.meta.url));
	const vendor = join(here, "..", "hooks", "board-html", "vendor");
	const bundles = readdirSync(vendor).filter((f) => f.endsWith(".js"));
	if (bundles.length === 0) {
		throw new Error(
			`no /vendor bundles in ${vendor} — the board pages cannot upgrade their Lit components`,
		);
	}
}
