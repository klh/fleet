// Dependency details on cards without cross-column connector lines.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-splines");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("blocked and split cards name their dependencies without connector lines", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const wA = b.mintedId(
		b.workOk(["add", "spline root", "--scope", "spl-root"]),
	);
	const wB = b.mintedId(
		b.workOk(["add", "spline dependent", "--scope", "spl-dep"]),
	);
	b.workOk(["block", wB, "--on", wA], "block wB on wA");
	const wP = b.mintedId(
		b.workOk(["add", "spline parent", "--scope", "spl-parent"]),
	);
	b.workOk(
		[
			"split",
			wP,
			"spline child one",
			"spline child two",
			"--reason",
			"independent-scopes",
		],
		"split wP",
	);

	await page.goto(`${b.BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await tabs.getByRole("button", { name: "Lanes" }).click();
	await expect(page.locator("#tab-lanes")).toBeVisible();
	await expect(page.locator(`[data-kid="${wA}"]`)).toBeVisible();
	await expect(page.locator(`[data-kid="${wP}"]`)).toBeVisible();

	// dep-aware ordering: the unmet provider's ready column precedes blocked.
	// Cards in separate columns can share the same vertical position.
	const aBox = await page.locator(`[data-kid="${wA}"]`).boundingBox();
	const bBox = await page.locator(`[data-kid="${wB}"]`).boundingBox();
	expect(aBox).not.toBeNull();
	expect(bBox).not.toBeNull();
	expect(aBox?.x ?? 0).toBeLessThan(bBox?.x ?? 0);

	await expect(page.locator(`[data-kid="${wB}"]`)).toContainText(
		`waiting on ${wA}`,
	);
	await expect(page.locator(`[data-kid="${wP}"]`)).toContainText("split into");
	await expect(page.locator("#ksplines")).toHaveCount(0);
	await expect(page.locator("#splinesLegend")).toHaveCount(0);

	await page.screenshot({ path: "board-splines.png", fullPage: true });
	expect(errors, "uncaught page exceptions").toEqual([]);
});
