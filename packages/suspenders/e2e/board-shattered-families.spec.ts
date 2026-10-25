// e2e/board-shattered-families.spec.ts — W819: the lanes kanban groups
// shattered families — the child a `work split` mints renders DIRECTLY
// beneath its SHATTERED parent card in the WAITING column (dashed border in
// the parent's --prefer color), not as a READY-column sibling. Scratch board
// + scratch repo (harness.ts); the repo's .prefer carries the color both
// cards inherit.
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

const COLOR = "#0058A3";
// #0058A3 = rgb(0, 88, 163)
const COLOR_RGB = "rgb(0, 88, 163)";

let board: Board | null = null;
let parentId = "";
let childId = "";
let child2Id = "";

test.beforeAll(async () => {
	board = await startBoard("board-shattered-families");
	// tree identity: the scratch repo's own .prefer carries the color
	writeFileSync(
		join(board.MY_PROJ, ".prefer"),
		`tag = "ikea"\ncolor = "${COLOR}"\n`,
	);
	const b = mustBoard();
	parentId = b.mintedId(
		b.workOk(["add", "shattered families parent"], "mint parent"),
	);
	// atomic shatter: parent → SHATTERED, the minted children → READY
	// (split needs ≥2 titles — minPos 3)
	const splitOut = b.workOk(
		[
			"split",
			parentId,
			"shattered families child one",
			"shattered families child two",
			"--reason",
			"independent-scopes",
		],
		"shatter the parent",
	);
	const kids = [...splitOut.matchAll(/\b(W\d+\.\d+)\b/g)].map((m) => m[1]);
	childId = kids[0] ?? "";
	child2Id = kids[1] ?? "";
	expect(childId, `no dotted child ids in: ${splitOut}`).toBeTruthy();
	expect(child2Id, `second child id missing in: ${splitOut}`).toBeTruthy();
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("split child nests beneath the SHATTERED parent card with the parent color", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#lanes`);
	const parentCard = page
		.locator(".kcard")
		.filter({ has: page.locator(`[data-task="${parentId}"]`) });
	await expect(parentCard).toBeVisible();
	const childCard = page
		.locator(".kcard.kkid")
		.filter({ has: page.locator(`[data-task="${childId}"]`) });
	await expect(childCard).toBeVisible();
	// the kid sits in the WAITING column, directly beneath its parent
	const colLabel = await childCard
		.locator("xpath=ancestor::div[contains(@class,'kcol')]/h3")
		.textContent();
	expect(colLabel).toContain("waiting");
	const prevKid = await childCard.evaluate((el) =>
		el.previousElementSibling?.getAttribute("data-kid"),
	);
	expect(prevKid).toBe(parentId);
	// the second sibling follows the first, both dashed in the parent color
	const child2Card = page
		.locator(".kcard.kkid")
		.filter({ has: page.locator(`[data-task="${child2Id}"]`) });
	await expect(child2Card).toBeVisible();
	const prev2 = await child2Card.evaluate((el) =>
		el.previousElementSibling?.getAttribute("data-kid"),
	);
	expect(prev2).toBe(childId);
	await expect
		.poll(async () =>
			child2Card.evaluate((el) => getComputedStyle(el).borderTopStyle),
		)
		.toBe("dashed");
	// dashed border in the parent's lane color
	await expect
		.poll(async () =>
			childCard.evaluate((el) => getComputedStyle(el).borderTopStyle),
		)
		.toBe("dashed");
	await expect
		.poll(async () =>
			childCard.evaluate((el) => getComputedStyle(el).borderTopColor),
		)
		.toBe(COLOR_RGB);
	await expect(childCard.locator(".kidmark")).toBeVisible();
});

test("the child leaves the READY column — no scattered duplicate", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#lanes`);
	const readyCol = page
		.locator(".kcol")
		.filter({ has: page.locator("h3", { hasText: "ready" }) });
	await expect(readyCol.locator(`.kcard[data-kid="${childId}"]`)).toHaveCount(
		0,
	);
	// waiting residents count = 1 (the parent alone; the kid is family detail)
	const waitCol = page
		.locator(".kcol")
		.filter({ has: page.locator("h3", { hasText: "waiting" }) });
	await expect(waitCol.locator(".kcount")).toHaveText("1");
});
