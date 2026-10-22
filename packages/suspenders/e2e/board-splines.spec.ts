// Dependency details on cards without cross-column connector lines.
// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("blocked and split cards name their dependencies without connector lines", async ({
	page,
	cleanBoard,
}) => {
	const b = cleanBoard;
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

	await page.goto(`${cleanBoard.BASE}/`);
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
});
