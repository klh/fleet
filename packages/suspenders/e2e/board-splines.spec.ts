// e2e/board-splines.spec.ts — W214: dependency splines on the lanes kanban.
// Seeds a blocked pair (W2 block --on W1) + a split parent, then asserts on
// the live page: overlay SVG present, orange blocked + green waiting paths,
// provider-above-dependent column ordering, legend, no page exceptions.
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

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

test("dependency splines render with blocked + waiting edges and dep-aware ordering", async ({
	page,
}) => {
	const b = mustBoard();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const wA = b.mintedId(b.workOk(["add", "spline root", "--scope", "spl-root"]));
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

	// dep-aware ordering: the unmet provider sits above its dependent
	const aBox = await page.locator(`[data-kid="${wA}"]`).boundingBox();
	const bBox = await page.locator(`[data-kid="${wB}"]`).boundingBox();
	expect(aBox).not.toBeNull();
	expect(bBox).not.toBeNull();
	expect(aBox?.y ?? 0).toBeLessThan(bBox?.y ?? 0);

	// splines: one orange blocked bezier + one green waiting bezier minimum
	// (> path — direct children only; the defs marker paths carry classes too).
	// Axis-aligned beziers own a zero-area bbox, which playwright reads as
	// hidden — assert presence + shape instead of visibility.
	await expect(page.locator("#ksplines")).toBeVisible();
	await expect(
		page.locator("#ksplines > path.spl-block"),
	).not.toHaveCount(0);
	const blockD = await page
		.locator("#ksplines > path.spl-block")
		.first()
		.getAttribute("d");
	expect(blockD).toContain("C");
	await expect(page.locator("#ksplines > path.spl-wait")).not.toHaveCount(0);
	const waitD = await page
		.locator("#ksplines > path.spl-wait")
		.first()
		.getAttribute("d");
	expect(waitD).toContain("C");
	await expect(page.locator("#splinesLegend")).toBeVisible();

	await page.screenshot({ path: "board-splines.png", fullPage: true });
	expect(errors, "uncaught page exceptions").toEqual([]);
});
