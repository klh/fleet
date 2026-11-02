// e2e/board-shell-editorial.spec.ts — W2267.1: the board chrome wears the
// editorial shell language in both themes: masthead rule + tracked mark,
// uppercase micro-label tabs with the accent underline, flat ruled orchestrate
// strip, text-rail status nav with tone-colored status text, paper/ink theme
// tokens — with every control preserved and polling never stealing input
// focus. Card interiors (kcard) and the activity plot are other lanes' scope.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-shell-editorial");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

const setTheme = async (
	page: import("@playwright/test").Page,
	theme: "light" | "dark",
): Promise<void> => {
	// pin the pref against the shared /api/theme pull-back (echo overwrites
	// localStorage across reload)
	await page.route("**/api/theme**", (route) =>
		route.fulfill({ contentType: "application/json", body: "{}" }),
	);
	await page.evaluate((t) => {
		localStorage.setItem("klh-theme", t);
	}, theme);
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

test("masthead keeps the editorial rule, tracked mark and every control", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/`);
	const header = page.locator("klh-board-mediator > header");
	await expect(header).toBeVisible();
	// the thick editorial masthead rule
	await expect
		.poll(async () =>
			header.evaluate((el) => getComputedStyle(el).borderTopWidth),
		)
		.toBe("3px");
	const mark = header.locator(".mark");
	await expect(mark).toHaveText("FLEET BOARD");
	const markFont = await mark.evaluate(
		(el) =>
			`${getComputedStyle(el).textTransform} ${getComputedStyle(el).fontWeight}`,
	);
	expect(markFont).toBe("uppercase 700");
	// controls preserved: search, conn banner, stamp, gated count, needs-you, project
	for (const sel of [
		"#boardSearch",
		"klh-conn-banner#conn",
		"#stamp",
		"#blockedn",
		"#needsn",
		"#proj",
	]) {
		await expect(header.locator(sel)).toBeAttached();
	}
	await expect(header.locator("label.plabel[for=proj]")).toBeVisible();
	expect(errors, "uncaught page exceptions").toEqual([]);
});

test("theme tokens hold in both themes: paper light, deep ink dark", {
	tag: "@ui",
}, async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/`);
	await setTheme(page, "light");
	const bg = () =>
		page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	await expect.poll(bg).toBe("rgb(246, 244, 239)"); // warm paper
	const ruleLight = await page
		.locator("klh-board-mediator > header")
		.evaluate((el) => getComputedStyle(el).borderTopColor);
	await page.goto(`${mustBoard().BASE}/`);
	await setTheme(page, "dark");
	await expect.poll(bg).toBe("rgb(20, 20, 19)"); // deep ink
	const ruleDark = await page
		.locator("klh-board-mediator > header")
		.evaluate((el) => getComputedStyle(el).borderTopColor);
	// the masthead rule is ink in both themes, not an accent leak
	expect(ruleLight).not.toBe(ruleDark);
	expect(ruleLight).toBe("rgb(28, 27, 25)");
	expect(ruleDark).toBe("rgb(232, 230, 225)");
});

test("section tabs render as uppercase micro-labels with the accent underline", {
	tag: "@ui",
}, async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await expect(tabs.getByRole("button")).toHaveCount(8);
	const cur = tabs.locator("button[aria-current]");
	await expect(cur).toHaveText("Decisions");
	const curStyle = await cur.evaluate(
		(el) =>
			`${getComputedStyle(el).textTransform}|${getComputedStyle(el).borderBottomColor}`,
	);
	expect(curStyle).toBe("uppercase|rgb(168, 106, 0)"); // light accent
	// switching still drives sections + hash
	await tabs.getByRole("button", { name: "Report" }).click();
	await expect(page.locator("#tab-report")).toBeVisible();
	await expect(page).toHaveURL(/#report$/);
});

test("orchestrate strip stays a flat ruled panel with intact expand/collapse", {
	tag: "@ui",
}, async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/`);
	const orch = page.locator("#orch");
	const radius = await orch.evaluate((el) => getComputedStyle(el).borderRadius);
	expect(radius).toBe("2px");
	await expect(orch).not.toHaveAttribute("open");
	await orch.locator("> summary").click();
	await expect(orch).toHaveAttribute("open");
	await expect(page.locator("#orchGoal")).toBeVisible();
	await page.locator("#orchCollapse").click();
	await expect(orch).not.toHaveAttribute("open");
});

test("lane status rail reads status as tone-colored text", {
	tag: "@ui",
}, async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/#lanes`);
	const ready = page.locator('#kstatusnav button[data-tone="ready"]');
	await expect(ready).toBeVisible();
	const readyStyle = await ready.evaluate(
		(el) =>
			`${getComputedStyle(el).borderTopWidth}|${getComputedStyle(el).borderTopStyle}`,
	);
	expect(readyStyle).toBe("2px|solid"); // tone rail rule
	// the attempt-view toggle still flips its pressed state
	const attempt = page.locator("#attemptView");
	await attempt.click();
	await expect(attempt).toHaveAttribute("aria-pressed", "true");
	await attempt.click();
	await expect(attempt).toHaveAttribute("aria-pressed", "false");
});

test("polling never erases search input, focus or filtering", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	const id = b.mintedId(
		b.workOk(["add", "Polling focus sentinel item"], "seed"),
	);
	await page.goto(`${b.BASE}/#tasks`);
	const search = page.locator("#boardSearch");
	await expect(search).toBeVisible();
	await search.click();
	await page.keyboard.type("sentinel");
	// >1 poll cycle (1Hz feed cadence) — focus, value and the filter survive
	await page.waitForTimeout(1600);
	await expect(search).toBeFocused();
	await expect(search).toHaveValue("sentinel");
	// the filter is real: the sentinel row shows, the seed crowd does not
	const rows = page.locator("#tasksBody tr");
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText(id);
	await expect(rows.first()).toContainText("Polling focus sentinel item");
});
