// e2e/console-forms.spec.ts — W695.3.2: the settings form widgets
// (<klh-executor-editor>, <klh-diff-view>) upgrade and drive the native
// form: editor edits write the light-DOM hidden input the preview POST
// carries; the preview page renders the diff in shadow DOM. Real
// fleet-board.ts on a scratch HOME (harness.ts).
// W1136: rides the shared fixtures — cleanBoard (fresh world per test) +
// the auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("executor editor: add/reorder/remove drives the hidden input; preview renders the diff", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	await page.goto(`${cleanBoard.BASE}/console/settings/suspenders`);
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
	// B1 regression guard: the carrier must be a REAL named form field — a
	// FormData walk over the live <form>, not just the input's .value, is
	// what a form-associated element without `name` would silently fail.
	const entries = await page.evaluate(() => {
		const input = document.querySelector(
			'input[name="default_executors"]',
		) as HTMLInputElement;
		const form = input.closest("form") as HTMLFormElement;
		return Array.from(new FormData(form).entries()).filter(
			([k]) => k === "default_executors",
		);
	});
	expect(entries).toEqual([["default_executors", "claude"]]);
	await page.getByRole("button", { name: "preview diff" }).click();
	const diff = page.locator("klh-diff-view");
	await expect(diff).toBeVisible();
	await expect(diff.locator("pre.diff .add:visible").first()).toBeVisible();
});
