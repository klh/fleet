// e2e/board-orchestrate.spec.ts — W875: the Orchestrate panel expands on
// CLICK only (no hover-open), and shows a minus control that collapses it.
// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("orchestrate panel: click to expand, minus to collapse, no hover", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/`);
	const orch = page.locator("#orch");
	const minus = page.locator("#orchCollapse");
	await expect(orch).toBeVisible();
	await expect(orch).not.toHaveAttribute("open");
	await expect(minus).toBeHidden();

	// hover must NOT expand (W875 removed the mouseenter open)
	await orch.hover();
	await expect(orch).not.toHaveAttribute("open");

	// click on the summary expands
	await orch.locator("> summary").click();
	await expect(orch).toHaveAttribute("open");
	await expect(minus).toBeVisible();

	// the minus control collapses
	await minus.click();
	await expect(orch).not.toHaveAttribute("open");
	await expect(minus).toBeHidden();

	// and a plain summary click still expands again
	await orch.locator("> summary").click();
	await expect(orch).toHaveAttribute("open");
});
