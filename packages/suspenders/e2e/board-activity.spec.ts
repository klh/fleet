// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("activity bars show counts and filter the event feed", async ({
	page,
	cleanBoard,
}) => {
	cleanBoard.workOk(["add", "Activity histogram sample"], "add work event");
	await page.goto(`${cleanBoard.BASE}/#activity`);
	const bars = page.locator("#actHist .acthist-bar");
	await expect(bars).toHaveCount(24);
	await expect(page.locator("#actHist")).toContainText("events");
	await expect(page.locator("#actBody")).toContainText("work.added");
	const nonempty = bars.filter({ has: page.locator(".acthist-stack > span") });
	await expect(nonempty.first()).toBeVisible();
	const first = nonempty.first();
	await first.hover();
	await expect(first.locator(".acthist-tip")).toBeVisible();
	await expect(first.locator(".acthist-tip")).toContainText("events");
	await expect(first).toHaveAttribute("aria-label", /work\.added/);
	await first.focus();
	await expect(first.locator(".acthist-tip")).toBeVisible();
	await first.click();
	await expect(page.locator("#actBody")).toContainText("selected interval");
	await page.locator("#actClear").click();
	await expect(page.locator("#actBody")).not.toContainText("selected interval");
});
