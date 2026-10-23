// e2e/board-orchestrate.spec.ts — W875: the Orchestrate panel expands on
// CLICK only (no hover-open), and shows a minus control that collapses it.
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-orchestrate");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("orchestrate panel: click to expand, minus to collapse, no hover", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/`);
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
	expect(errors, "uncaught page exceptions").toEqual([]);
});
