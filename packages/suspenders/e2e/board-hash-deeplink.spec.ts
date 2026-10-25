// e2e/board-hash-deeplink.spec.ts — W890: query-style tab-hash deep links
// against the live board: #lanes?w=<id> selects the card + opens the
// drawer; ?project/?q scope + filter; unknown params warn without
// breaking the tab switch; legacy #task= stays compatible.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let wid = "";

test.beforeAll(async () => {
	board = await startBoard("board-hash-deeplink");
	wid = board.mintedId(
		board.workOk(["add", "deep-link target item"], "mint the target item"),
	);
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("#lanes?w=<id> lands on lanes, selects the card, opens the drawer", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/#lanes?w=${wid}`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Lanes",
	);
	await expect(page.locator("#drawer")).toBeVisible();
	await expect(page.locator("#drawerTitle")).toContainText(wid);
	const card = page.locator(`.kcard[data-kid="${wid}"]`);
	await expect(card).toBeVisible();
	await expect(card).toHaveClass(/ksel/);
	expect(errors, "uncaught page exceptions").toEqual([]);
});

test("legacy #task=<id> still opens the drawer", { tag: "@ui" }, async ({
	page,
}) => {
	await page.goto(`${mustBoard().BASE}/#task=${wid}`);
	await expect(page.locator("#drawer")).toBeVisible();
	await expect(page.locator("#drawerTitle")).toContainText(wid);
});

test("?q= filters; unknown params warn but tabs still switch", {
	tag: "@ui",
}, async ({ page }) => {
	const warns: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "warning") warns.push(m.text());
	});
	await page.goto(`${mustBoard().BASE}/#tasks?q=deep`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Tasks",
	);
	await expect(page.locator("#hashChipBar")).toContainText("filtered by");
	await page.goto(`${mustBoard().BASE}/#setup?bogus=1`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Setup",
	);
	expect(warns.some((w) => w.includes("bogus"))).toBe(true);
});

test("?project=<alias> selects the global scope", { tag: "@ui" }, async ({
	page,
}) => {
	await page.goto(
		`${mustBoard().BASE}/#tasks?project=${mustBoard().projShort}`,
	);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Tasks",
	);
	await expect(page.locator("#proj")).toHaveValue(
		new RegExp(mustBoard().projShort),
	);
});
