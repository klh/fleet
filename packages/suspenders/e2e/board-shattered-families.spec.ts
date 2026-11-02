// e2e/board-shattered-families.spec.ts — W819: the lanes kanban groups
// shattered families — the child a `work split` mints renders DIRECTLY
// beneath its SHATTERED parent card in the WAITING column (dashed border in
// the parent's --prefer color), not as a READY-column sibling. Scratch board
// + scratch repo (harness.ts); the repo's .prefer carries the color both
// cards inherit.
// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone, and each
// test seeds its own shattered family (hermetic, no shared module state).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import type { Board } from "../test/helpers/board-harness";
import { expect, test } from "./fixtures";

const COLOR = "#0058A3";
// #0058A3 = rgb(0, 88, 163)
const COLOR_RGB = "rgb(0, 88, 163)";

/** Seed one shattered family on a fresh world; returns the card ids. */
function seedFamily(b: Board): {
	parentId: string;
	childId: string;
	child2Id: string;
} {
	// tree identity: the scratch repo's own .prefer carries the color
	writeFileSync(
		join(b.MY_PROJ, ".prefer"),
		`tag = "ikea"\ncolor = "${COLOR}"\n`,
	);
	const parentId = b.mintedId(
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
	const childId = kids[0] ?? "";
	const child2Id = kids[1] ?? "";
	expect(childId, `no dotted child ids in: ${splitOut}`).toBeTruthy();
	expect(child2Id, `second child id missing in: ${splitOut}`).toBeTruthy();
	return { parentId, childId, child2Id };
}

test("split child nests beneath the SHATTERED parent card with the parent color", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const { parentId, childId, child2Id } = seedFamily(cleanBoard);
	await page.goto(`${cleanBoard.BASE}/#lanes`);
	// W2267.4.2.2: the card IS the klh-task-card-host bridge — identity
	// rides the host's own data-kid attribute (light DOM), not the shadow
	// tid button the legacy .kcard string carried (ids are unique per
	// scratch world; data-kproj is the project identity path, not projShort).
	const parentCard = page.locator(`.kcard[data-kid="${parentId}"]`);
	await expect(parentCard).toBeVisible();
	const childCard = page.locator(`.kcard.kkid[data-kid="${childId}"]`);
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
	const child2Card = page.locator(`.kcard.kkid[data-kid="${child2Id}"]`);
	await expect(child2Card).toBeVisible();
	const prev2 = await child2Card.evaluate((el) =>
		el.previousElementSibling?.getAttribute("data-kid"),
	);
	expect(prev2).toBe(childId);
	// W819 dashed border rides the inner klh-task-card (data-nested, its
	// own compiled SCSS); the .kcard wrapper carries border:0 by design.
	// The elbow (↳) replaces the retired light-DOM kidmark.
	const kidBorder = (card: Locator) =>
		card
			.locator("klh-task-card")
			.evaluate(
				(el) =>
					`${getComputedStyle(el).borderTopStyle} ${getComputedStyle(el).borderTopColor}`,
			);
	await expect.poll(() => kidBorder(childCard)).toBe(`dashed ${COLOR_RGB}`);
	await expect.poll(() => kidBorder(child2Card)).toBe(`dashed ${COLOR_RGB}`);
	await expect(childCard.locator("klh-task-card .elbow")).toBeVisible();
});

test("the child leaves the READY column — no scattered duplicate", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const { childId } = seedFamily(cleanBoard);
	await page.goto(`${cleanBoard.BASE}/#lanes`);
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
