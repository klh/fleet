// e2e/board-kanban-column-order.spec.ts — W1006: kanban columns read
// ready → waiting → working → blocked → failed → done → cancelled at
// desktop width and on a narrow screen; the kstatusnav jump buttons
// follow the same order (keyboard order = column order).
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-kanban-column-order");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

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

async function assertOrder(page: import("@playwright/test").Page) {
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

test("column order holds at desktop width and on a narrow screen", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${mustBoard().BASE}/#lanes`);
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);

	await page.setViewportSize({ width: 420, height: 800 });
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);
});
