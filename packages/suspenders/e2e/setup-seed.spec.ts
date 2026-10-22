// e2e/setup-seed.spec.ts — W852: the setup checklist is seeded server-side —
// the Setup tab paints real check cards on first paint (no "loading setup
// checks..." flash), from the same stale-while-revalidate cache /api/setup
// serves. Scratch-HOME board via the shared harness.
// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("setup tab paints seeded cards, never the loading flash", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/#setup`);
	// seeded synchronously from window.__SETUP__ at boot — no fetch wait
	await expect(page.locator("#setupBody .scard")).not.toHaveCount(0);
	// the loading placeholder never shows — the seed beat it
	await expect(page.getByText("loading setup checks...")).toHaveCount(0);
	// the check cards render real label/detail/fix structure
	await expect(page.locator("#setupBody .scard").first()).toContainText(
		"Control-plane database",
	);
});
