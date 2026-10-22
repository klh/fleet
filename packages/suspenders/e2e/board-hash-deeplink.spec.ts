// e2e/board-hash-deeplink.spec.ts — W890: query-style tab-hash deep links
// against the live board: #lanes?w=<id> selects the card + opens the
// drawer; ?project/?q scope + filter; unknown params warn without
// breaking the tab switch; legacy #task= stays compatible.
// W1136: rides the shared fixtures — cleanBoard per test (each test mints
// its own deep-link target on a fresh world) + the auto pageWatcher; the
// beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("#lanes?w=<id> lands on lanes, selects the card, opens the drawer", async ({
	page,
	cleanBoard,
}) => {
	const wid = cleanBoard.mintedId(
		cleanBoard.workOk(["add", "deep-link target item"], "mint the target item"),
	);
	await page.goto(`${cleanBoard.BASE}/#lanes?w=${wid}`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Lanes",
	);
	await expect(page.locator("#drawer")).toBeVisible();
	await expect(page.locator("#drawerTitle")).toContainText(wid);
	const card = page.locator(`.kcard[data-kid="${wid}"]`);
	await expect(card).toBeVisible();
	await expect(card).toHaveClass(/ksel/);
});

test("legacy #task=<id> still opens the drawer", async ({
	page,
	cleanBoard,
}) => {
	const wid = cleanBoard.mintedId(
		cleanBoard.workOk(["add", "deep-link target item"], "mint the target item"),
	);
	await page.goto(`${cleanBoard.BASE}/#task=${wid}`);
	await expect(page.locator("#drawer")).toBeVisible();
	await expect(page.locator("#drawerTitle")).toContainText(wid);
});

test("?q= filters; unknown params warn but tabs still switch", async ({
	page,
	cleanBoard,
}) => {
	const warns: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "warning") warns.push(m.text());
	});
	await page.goto(`${cleanBoard.BASE}/#tasks?q=deep`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Tasks",
	);
	await expect(page.locator("#hashChipBar")).toContainText("filtered by");
	await page.goto(`${cleanBoard.BASE}/#setup?bogus=1`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Setup",
	);
	expect(warns.some((w) => w.includes("bogus"))).toBe(true);
});

test("?project=<alias> selects the global scope", async ({
	page,
	cleanBoard,
}) => {
	// the scope select only lists RESIDENT projects — mint one first so the
	// virgin board's option list carries this world's project
	cleanBoard.workOk(["add", "project scope probe"], "mint a project resident");
	await page.goto(`${cleanBoard.BASE}/#tasks?project=${cleanBoard.projShort}`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Tasks",
	);
	await expect(page.locator("#proj")).toHaveValue(
		new RegExp(cleanBoard.projShort),
	);
});
