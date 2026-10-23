// e2e/board-tabs.spec.ts — W695.3.6: the board's section tabs are the
// <klh-board-tabs> Lit component. Click → tab-select → setTab flips the
// aria-current marker, the visible section and location.hash; a hash
// deep-link lands on the right tab; Usage stays inside the board shell.
// W1136: rides the shared fixtures — worker board + the auto pageWatcher;
// the beforeAll(startBoard) copy is gone.
import { expect, test } from "./fixtures";

test("tabs component drives sections, hash and aria-current", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await expect(tabs).toBeVisible();
	await expect(tabs.getByRole("button")).toHaveCount(7);
	const cur = tabs.locator("button[aria-current]");
	await expect(cur).toHaveText("Decisions");
	await expect(page.locator("#tab-decisions")).toBeVisible();

	await tabs.getByRole("button", { name: "Lanes" }).click();
	await expect(cur).toHaveText("Lanes");
	await expect(cur).toHaveCount(1);
	await expect(page.locator("#tab-lanes")).toBeVisible();
	await expect(page.locator("#tab-decisions")).toBeHidden();
	expect(new URL(page.url()).hash).toBe("#lanes");

	// back/forward drives the component through the hashchange path
	await page.goBack();
	await expect(cur).toHaveText("Decisions");

	await page.goto(`${board.BASE}/#setup`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Setup",
	);
	await expect(page.locator("#tab-setup")).toBeVisible();

	await tabs.getByRole("button", { name: "Usage" }).click();
	await expect(page.locator("#tab-usage")).toBeVisible();
	await expect(page).toHaveURL(/#usage$/);
	await expect(page.locator("klh-usage-charts")).toBeVisible();
	await expect(page.locator("#tab-usage .uplot").first()).toBeVisible();
	await page.goBack();
	await expect(page.locator("#tab-setup")).toBeVisible();
});

test("Usage filters and old links preserve the board shell", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/#setup`);
	const shell = page.locator("klh-topbar");
	await page
		.locator("klh-board-tabs")
		.getByRole("button", { name: "Usage" })
		.click();
	await expect(
		page.locator("klh-usage-header").getByRole("link", { name: "7d" }),
	).toBeVisible();
	await page
		.locator("klh-usage-header")
		.getByRole("link", { name: "7d" })
		.click();
	await expect(page).toHaveURL(/#usage\?days=7$/);
	await expect(page.locator("klh-usage-charts")).toBeVisible();
	await expect(shell).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(/#usage$/);
	await page.goto(`${board.BASE}/usage?days=7&team=platform#cache`);
	await expect(page).toHaveURL(/#usage\?days=7&team=platform&section=cache$/);
	await expect(page.locator("#tab-usage")).toBeVisible();
});

test("changing sections starts at the header after a deep scroll", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/#lanes`);
	await page.evaluate(() => {
		const filler = document.createElement("div");
		filler.style.height = "2400px";
		document.querySelector("#tab-lanes")?.append(filler);
		window.scrollTo(0, 1200);
	});
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(0);
	await page.evaluate(() => {
		window.location.hash = "tasks";
	});
	await expect(page.locator("#tab-tasks")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("lane status rail reaches offscreen columns by mouse and keyboard", async ({
	page,
	board,
}) => {
	await page.setViewportSize({ width: 960, height: 700 });
	await page.goto(`${board.BASE}/#lanes`);
	const rail = page.locator("#kstatusnav");
	// one button per KCOLS status (8); the hideEmpty ones (paused/blocked/
	// failed) hide while empty, so visible buttons track the rendered 1:1
	await expect(rail.locator("button")).toHaveCount(8);
	await expect
		.poll(
			async () =>
				(await rail.getByRole("button").count()) -
				(await page.locator("#kanban .kcol").count()),
		)
		.toBe(0);
	const wrap = page.locator(".kwrap");
	expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
		true,
	);
	await rail.getByRole("button", { name: /^done /i }).click();
	await expect
		.poll(() => wrap.evaluate((el) => el.scrollLeft))
		.toBeGreaterThan(0);
	await rail.getByRole("button", { name: /^ready /i }).focus();
	await rail.getByRole("button", { name: /^ready /i }).press("Enter");
	await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBe(0);
});

test("task rows start compact and identify an unnamed owner by model", async ({
	page,
	board,
}) => {
	const sid = "01a15006-3fc1-76e1-abe1-af8a11d44426";
	await page.route("**/api/tasks?**", async (route) => {
		const response = await route.fetch();
		const payload = await response.json();
		payload.tasks.unshift({
			id: "W9999",
			project: "/tmp/fleet/.git",
			title: "Inspect failed route",
			state: "FAILED",
			owner_sid: sid,
			owner_label: sid,
			age_s: 90,
			updated_at_utc: new Date().toISOString(),
			tail: { text: "Detailed failure output kept for inspection" },
			spend: {
				fresh: 30,
				cached: 60,
				out: 10,
				wall_ms: 1000,
				model_groups: { "glm-5.3-flash": { requests: 2 } },
			},
		});
		payload.tasks.push({
			id: "W9998",
			project: "/tmp/fleet/.git",
			title: "Related item without attribution",
			state: "CLAIMED",
			owner_sid: sid,
			owner_label: sid,
			age_s: 60,
			updated_at_utc: new Date().toISOString(),
		});
		await route.fulfill({ response, json: payload });
	});
	await page.goto(`${board.BASE}/#tasks`);
	const row = page.locator('tr[data-tid="W9999"]');
	await expect(row).toBeVisible();
	await expect(row.locator(".taskowner")).toContainText("glm-5.3-flash");
	await expect(row.locator(".taskowner")).not.toContainText(sid);
	await expect(row.locator(".taskowner")).toHaveAttribute("title", sid);
	await expect(row.locator(".tail")).toBeHidden();
	const details = page.getByRole("button", { name: "row details" });
	await details.click();
	await expect(details).toHaveAttribute("aria-pressed", "true");
	await expect(row.locator(".tail")).toBeVisible();
	await page.reload();
	await expect(page.locator('tr[data-tid="W9999"] .tail')).toBeVisible();
});
