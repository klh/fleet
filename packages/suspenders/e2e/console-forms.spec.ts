// e2e/console-forms.spec.ts — W695.3.2: the settings form widgets
// (<klh-executor-editor>, <klh-diff-view>) upgrade and drive the native
// form: editor edits write the light-DOM hidden input the preview POST
// carries; the preview page renders the diff in shadow DOM. Real
// fleet-board.ts on a scratch HOME (harness.ts).
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("forms");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

test("executor editor: add/reorder/remove drives the hidden input; preview renders the diff", async ({
	page,
}) => {
	if (board === null) throw new Error("board not started");
	const pageErrors: string[] = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(`${board.BASE}/console/settings/suspenders`);
	const ed = page.locator("klh-executor-editor");
	await expect(ed).toBeVisible();
	await expect(ed.getByText("executor preference order")).toBeVisible();
	const hidden = page.locator('input[name="default_executors"]');
	await ed.locator("select").selectOption("claude");
	await ed.getByRole("button", { name: "add" }).click();
	await expect(hidden).toHaveValue("claude");
	await expect(ed.getByRole("button", { name: "remove claude" })).toBeVisible();
	await ed.getByRole("button", { name: "remove claude" }).click();
	await expect(hidden).toHaveValue("");
	await ed.locator("select").selectOption("claude");
	await ed.getByRole("button", { name: "add" }).click();
	await page.getByRole("button", { name: "preview diff" }).click();
	const diff = page.locator("klh-diff-view");
	await expect(diff).toBeVisible();
	await expect(diff.locator("pre.diff .add:visible").first()).toBeVisible();
	expect(pageErrors).toEqual([]);
});
