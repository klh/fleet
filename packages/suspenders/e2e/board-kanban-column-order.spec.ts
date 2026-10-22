// e2e/board-kanban-column-order.spec.ts — W1006: kanban columns read
// ready → waiting → working → blocked → failed → done → cancelled at
// desktop width and on a narrow screen; the kstatusnav jump buttons
// follow the same order (keyboard order = column order).
// W1136: rides the shared fixtures — worker board + the auto pageWatcher;
// the beforeAll(startBoard) copy is gone, and the desktop/narrow viewport
// split is the projects matrix (chromium-desktop / chromium-narrow) instead
// of a manual setViewportSize call.
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const ORDER = [
	"ready",
	"waiting",
	"claimed",
	"paused",
	"blocked",
	"failed",
	"done",
	"cancelled",
];

async function assertOrder(page: Page) {
	const labels = await page.locator(".kanban .kcol h3").allInnerTexts();
	expect(
		labels.map((l) =>
			l
				.replace(/\s*\d+\s*$/, "")
				.trim()
				.toLowerCase(),
		),
	).toEqual(ORDER);
	const nav = await page.locator("#kstatusnav button").allInnerTexts();
	expect(
		nav.map((l) =>
			l
				.replace(/\s*\d+\s*$/, "")
				.trim()
				.toLowerCase(),
		),
	).toEqual(ORDER);
}

test("column order holds at desktop width", async ({
	page,
	board,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "chromium-desktop",
		"desktop project runs the desktop-width assertion",
	);
	await page.goto(`${board.BASE}/#lanes`);
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);
});

test("column order holds on a narrow screen", async ({
	page,
	board,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "chromium-narrow",
		"narrow project runs the narrow-screen assertion",
	);
	await page.goto(`${board.BASE}/#lanes`);
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);
});
