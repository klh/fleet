// e2e/board-tabs.spec.ts — W695.3.6: the board's section tabs are the
// <klh-board-tabs> Lit component. Click → tab-select → setTab flips the
// aria-current marker, the visible section and location.hash; a hash
// deep-link lands on the right tab; the Usage link leaves the SPA.
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-tabs");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("tabs component drives sections, hash and aria-current", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await expect(tabs).toBeVisible();
	await expect(tabs.getByRole("button")).toHaveCount(6);
	const cur = tabs.locator("button[aria-current]");
	await expect(cur).toHaveText("Decisions");
	await expect(page.locator("#tab-decisions")).toBeVisible();

	await tabs.getByRole("button", { name: "Lanes" }).click();
	await expect(cur).toHaveText("Lanes");
	await expect(cur).toHaveCount(1);
	await expect(page.locator("#tab-lanes")).toBeVisible();
	await expect(page.locator("#tab-decisions")).toBeHidden();
	expect(new URL(page.url()).hash).toBe("#lanes");

	// back/forward drives the component through the hashchange path
	await page.goBack();
	await expect(cur).toHaveText("Decisions");

	await page.goto(`${mustBoard().BASE}/#setup`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Setup",
	);
	await expect(page.locator("#tab-setup")).toBeVisible();

	await expect(tabs.getByRole("link", { name: "Usage" })).toHaveAttribute(
		"href",
		"/usage",
	);
	expect(errors, "uncaught page exceptions").toEqual([]);
});
