// e2e/board-kanban-column-order.spec.ts — W1006: kanban columns read
// ready → waiting → working → blocked → failed → done → cancelled at
// desktop width and on a narrow screen; the kstatusnav jump buttons
// follow the same order (keyboard order = column order).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { startBoard, type Board } from "./harness";

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-kanban-column-order");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

const ORDER = ["ready", "waiting", "claimed", "done", "cancelled"];

async function assertOrder(page: import("@playwright/test").Page) {
	const labels = await page.locator(".kanban .kcol h3").allInnerTexts();
	expect(
		labels.map((l) =>
			l
				.replace(/\s*\d+\s*$/, "")
				.trim()
				.toLowerCase(),
		),
	).toEqual(ORDER);
	const nav = await page.locator("#kstatusnav button:visible").allInnerTexts();
	expect(
		nav.map((l) =>
			l
				.replace(/\s*\d+\s*$/, "")
				.trim()
				.toLowerCase(),
		),
	).toEqual(ORDER);
}

test("column order holds at desktop width and on a narrow screen", {
	tag: "@ui",
}, async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${mustBoard().BASE}/#lanes`);
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);

	await page.setViewportSize({ width: 420, height: 800 });
	await expect(page.locator(".kanban .kcol")).toHaveCount(ORDER.length);
	await assertOrder(page);
});

test("empty conditional columns follow filtered task transitions and keep jump targets stable", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	const otherProject = `${b.MY_PROJ}-other`;
	const db = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	const now = Date.now();
	for (const [project, id, state] of [
		[b.MY_PROJ, "WFAIL", "FAILED"],
		[b.MY_PROJ, "WBLOCK", "READY"],
		[otherProject, "WOTHER", "FAILED"],
	])
		db.query(
			"INSERT INTO work_items(project,id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
		).run(project, id, id, state, now, now);
	db.query(
		"INSERT INTO work_deps(project,work_id,depends_on) VALUES (?,?,?)",
	).run(b.MY_PROJ, "WBLOCK", "WFAIL");
	try {
		await page.goto(`${b.BASE}/#lanes`);
		await expect(page.locator('.kcol[data-kcol-key="FAILED"]')).toBeVisible();
		await expect(page.locator('.kcol[data-kcol-key="BLOCKED"]')).toBeVisible();
		await expect(page.locator('.kcol[data-kcol-key="PAUSED"]')).toHaveCount(0);
		await page.locator("#proj").selectOption(b.MY_PROJ);
		await expect(
			page.locator('.kcol[data-kcol-key="FAILED"] .kcount'),
		).toHaveText("1");
		db.query(
			"UPDATE work_items SET state='DONE' WHERE project=? AND id='WFAIL'",
		).run(b.MY_PROJ);
		await page.reload();
		await page.locator("#proj").selectOption(b.MY_PROJ);
		await expect(page.locator('.kcol[data-kcol-key="FAILED"]')).toHaveCount(0);
		await expect(page.locator('.kcol[data-kcol-key="BLOCKED"]')).toHaveCount(0);
		await expect(
			page.locator("#kstatusnav button").filter({ hasText: /^failed / }),
		).toBeHidden();
		await expect(
			page.locator("#kstatusnav button").filter({ hasText: /^blocked / }),
		).toBeHidden();
		await assertOrder(page);
		// Removed columns must not shift the stable jump target for later columns.
		await page.setViewportSize({ width: 420, height: 800 });
		await page
			.locator("#kstatusnav button")
			.filter({ hasText: /^done / })
			.click();
		await expect
			.poll(() =>
				page.locator('.kcol[data-kcol-key="DONE"]').evaluate((el) => {
					const wrap = document.getElementById("kanban")?.parentElement;
					if (!wrap) throw new Error("missing kanban scroller");
					return Math.abs(
						el.getBoundingClientRect().left - wrap.getBoundingClientRect().left,
					);
				}),
			)
			.toBeLessThan(5);
		await page.locator("#proj").selectOption(otherProject);
		await expect(
			page.locator('.kcol[data-kcol-key="FAILED"] .kcount'),
		).toHaveText("1");
		await expect(
			page.locator("#kstatusnav button").filter({ hasText: /^failed 1$/ }),
		).toBeVisible();
	} finally {
		db.close();
	}
});
