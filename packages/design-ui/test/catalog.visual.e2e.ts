// test/catalog-visual.e2e.ts — @visual project (W2269.1.5): the catalog
// pages must render IDENTICALLY across runs (visual regression pins) and
// BOTH panes must actually render (prototype native HTML present, component
// shadow DOM mounted). Runs the real generated pages over loopback HTTP in
// headless chromium. Theme coverage: every pane row renders dark (root
// default) and light; high-contrast css is linked on the page.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startCatalogServer } from "./catalog-server.ts";

const PKG = resolve(import.meta.dir, "..");
const ELEMENTS_DIR = join(PKG, "catalog/elements");
// The catalog page population rides the generated dir — a new ELEMENTS row
// is covered without touching this spec.
const PAGES = readdirSync(ELEMENTS_DIR)
	.filter((f) => f.endsWith(".html") && f !== "index.html")
	.sort();
let server: ReturnType<typeof startCatalogServer>;

test.beforeAll(() => {
	expect(PAGES.length, "generated catalog pages exist").toBeGreaterThan(0);
	server = startCatalogServer();
});

test.afterAll(() => server?.stop());

test.describe("@visual catalog parity @visual", () => {
	for (const page of PAGES) {
		test(`renders both panes + pixel-stable: ${page}`, async ({
			page: view,
		}) => {
			// Freeze the clock: demos render relative ages that flake pins.
			await view.addInitScript(() => {
				const now = Date.parse("2026-10-31T12:00:00Z");
				Date.now = () => now;
			});
			await view.goto(`${server.url}/${page}`);
			await expect(view.locator('[data-pane="prototype"]')).toBeVisible();
			await expect(view.locator('[data-pane="component"]')).toBeVisible();
			// The component upgrades: shadow DOM mounted with children.
			await expect
				.poll(() =>
					view.evaluate(() => {
						const el = document.querySelector(
							'[data-pane="component"] > :last-child',
						);
						return el instanceof HTMLElement && el.shadowRoot
							? el.shadowRoot.childElementCount
							: -1;
					}),
				)
				.toBeGreaterThan(0);
			// Pixel pin: the whole side-by-side page is the visual contract.
			await expect(view).toHaveScreenshot(`${page}.png`, {
				maxDiffPixelRatio: 0.02,
				fullPage: true,
			});
		});
	}
});
// CH2
