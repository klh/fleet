import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("activity-histogram");
	board.workOk(["add", "Activity histogram sample"], "add work event");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

test("activity bars show counts and filter the event feed", async ({
	page,
}) => {
	if (!board) throw new Error("board not started");
	await page.goto(`${board.BASE}/#activity`);
	const bars = page.locator("#actHist .acthist-bar");
	await expect(bars).toHaveCount(24);
	await expect(page.locator("#actHist")).toContainText("events");
	await expect(page.locator("#actBody")).toContainText("work.added");
	const nonempty = bars.filter({ has: page.locator(".acthist-stack > span") });
	await expect(nonempty.first()).toBeVisible();
	await nonempty.first().click();
	await expect(page.locator("#actBody")).toContainText("selected interval");
	await page.locator("#actClear").click();
	await expect(page.locator("#actBody")).not.toContainText("selected interval");
});
