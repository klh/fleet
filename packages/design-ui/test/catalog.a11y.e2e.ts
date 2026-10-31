// test/catalog-a11y.e2e.ts — @a11y project (W2269.1.5). Hand-rolled
// axe-free accessibility checks on every catalog page (skeleton index +
// element pages): NO new test dependency — axe-core would follow the
// dependency-allowlist procedure; these checks ride the existing
// @playwright/test toolchain only. Asserts per page: lang, title, a main
// landmark, an h1, every button has an accessible name, no positive
// tabindex, every img an alt, and every custom element instance mounts a
// non-empty shadow root.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startCatalogServer } from "./catalog-server.ts";

const PKG = resolve(import.meta.dir, "..");
const ELEMENTS_DIR = join(PKG, "catalog/elements");
const PAGES = readdirSync(ELEMENTS_DIR)
	.filter((f) => f.endsWith(".html"))
	.sort();

let server: ReturnType<typeof startCatalogServer>;

test.beforeAll(() => {
	expect(PAGES.length).toBeGreaterThan(0);
	server = startCatalogServer();
});

test.afterAll(() => server?.stop());

test.describe("@a11y catalog checks @a11y", () => {
	for (const page of PAGES) {
		test(`a11y invariants: ${page}`, async ({ page: view }) => {
			await view.goto(`${server.url}/${page}`);
			// Document-level invariants.
			expect(await view.title()).not.toBe("");
			expect(await view.locator("html").getAttribute("lang")).toBe("en");
			await expect(view.locator("main")).toHaveCount(1);
			await expect(view.locator("h1")).toHaveCount(1);
			// Every interactive control names itself.
			const unnamed = await view.evaluate(() =>
				[...document.querySelectorAll("button, a[href]")]
					.filter((el) => !(el as HTMLElement).innerText.trim())
					.map((el) => el.outerHTML.slice(0, 80)),
			);
			expect(unnamed, "buttons/links need accessible names").toEqual([]);
			// No positive tabindex (tab-order poisoning).
			expect(
				await view.evaluate(
					() => document.querySelectorAll("[tabindex]").length,
				),
			).toBe(0);
			// Images name themselves.
			expect(
				await view.evaluate(() =>
					[...document.querySelectorAll("img")]
						.filter((el) => !el.hasAttribute("alt"))
						.map((el) => el.outerHTML.slice(0, 80)),
				),
			).toEqual([]);
			// Every custom element upgraded with a non-empty shadow root.
			const unrendered = await view.evaluate(() =>
				[...document.querySelectorAll("*")]
					.filter((el) => el.tagName.includes("-"))
					.filter(
						(el) => !el.shadowRoot || el.shadowRoot.childElementCount === 0,
					)
					.map((el) => el.tagName),
			);
			expect(unrendered, "custom elements must mount").toEqual([]);
		});
	}
});
