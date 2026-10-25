// e2e/setup-seed.spec.ts — W852: the setup checklist is seeded server-side —
// the Setup tab paints real check cards on first paint (no "loading setup
// checks..." flash), from the same stale-while-revalidate cache /api/setup
// serves. Scratch-HOME board via the shared harness.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("setup-seed");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("setup tab paints seeded cards, never the loading flash", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/#setup`);
	// seeded synchronously from window.__SETUP__ at boot — no fetch wait
	await expect(page.locator("#setupBody .scard")).not.toHaveCount(0);
	// the loading placeholder never shows — the seed beat it
	await expect(page.getByText("loading setup checks...")).toHaveCount(0);
	// the check cards render real label/detail/fix structure
	await expect(page.locator("#setupBody .scard").first()).toContainText(
		"Control-plane database",
	);
	await expect.poll(() => errors.length, { intervals: [500, 1000] }).toBe(0);
});
