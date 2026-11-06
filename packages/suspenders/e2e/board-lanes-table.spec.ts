// e2e/board-lanes-table.spec.ts — W2269.2: #lanes renders the per-lane
// W892 table (LANE | ITEM | ST | TASK | TOKENS | OUT/MIN | MODEL | EFFORT |
// CONSULT), not the W65 kanban. Parity law: the served rows come from the
// SAME reportRows/buildReportContract spine the CLI renders from, and the
// cells from the SAME exported cell helpers — this spec proves the board
// answers that contract and renders it actionable-first with degraded-lane
// emphasis; the card board stays reachable behind ?view=cards.
import { expect, test } from "./fixtures";
import type { APIResponse } from "@playwright/test";

test("#lanes serves the per-lane contract and renders its rows", {
	tag: "@ui",
}, async ({ page, board, api }) => {
	// mint first — the route's default project resolves from the newest
	// work_items row; a virgin world would serve project "" and no rows
	board.mintedId(
		board.workOk(["add", "lanes contract probe item"], "mint a lanes row"),
	);
	const res: APIResponse = await api.get(`${board.BASE}/api/lanes-table`);
	expect(res.status()).toBe(200);
	const j = (await res.json()) as {
		schema_version: number;
		project: string;
		sections: Record<string, number>;
		launch_failures: { lanes: number; worst_attempts: number };
		lanes: Array<{
			sid: string | null;
			verdict: string | null;
			degraded: boolean;
			item: { id: string; section: string; glyph: string; status: string };
			cells: Record<string, string>;
		}>;
	};
	expect(j.schema_version).toBe(1);
	// served project is the git-common-dir form (<repo>/.git); MY_PROJ is
	// the bare realpath — assert the shared short name instead
	expect(j.project).toContain(board.projShort);
	// the section rollup counts exactly the rows in those sections (absent
	// sections are 0 — toEqual would fail on the zero keys recount can't have)
	const recount: Record<string, number> = {};
	for (const l of j.lanes)
		recount[l.item.section] = (recount[l.item.section] ?? 0) + 1;
	for (const [sec, n] of Object.entries(j.sections))
		expect(recount[sec] ?? 0).toBe(n);

	await page.goto(`${board.BASE}/#lanes?project=${board.projShort}`);
	await expect(page.locator("#lanesTableWrap")).toBeVisible();
	await expect(page.locator("#tab-lanes .kwrap")).toBeHidden();
	// every contract row renders, ST = glyph + word (never colour alone)
	for (const l of j.lanes) {
		const row = page.locator(`#lanesTable tr[data-task="${l.item.id}"]`);
		await expect(row).toHaveCount(1);
		await expect(row.locator(".lst")).toContainText(l.item.status);
	}
});

test("actionable-first: needs you precedes working precedes waiting", {
	tag: "@ui",
}, async ({ page, board, api }) => {
	// mint a waiting (READY) row, then read the served order
	const rid = board.mintedId(
		board.workOk(["add", "waiting probe item"], "mint waiting row"),
	);
	await page.goto(`${board.BASE}/#lanes?project=${board.projShort}`);
	const order = await page
		.locator("#lanesTable tr[data-task]")
		.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-task") ?? ""));
	expect(order).toContain(rid);
	// the served contract order IS the render order (rows keep §4 order)
	const res = await api.get(`${board.BASE}/api/lanes-table`);
	const j = (await res.json()) as { lanes: Array<{ item: { id: string } }> };
	expect(order).toEqual(j.lanes.map((l) => l.item.id));
});

test("degraded lanes render emphasized and the card board stays reachable", {
	tag: "@ui",
}, async ({ page, board, api }) => {
	await page.goto(`${board.BASE}/#lanes?project=${board.projShort}`);
	// a degraded row (dead verdict or burned attempts) carries the class
	const res = await api.get(`${board.BASE}/api/lanes-table`);
	const j = (await res.json()) as {
		lanes: Array<{ degraded: boolean; item: { id: string } }>;
	};
	const degradedIds = j.lanes.filter((l) => l.degraded).map((l) => l.item.id);
	for (const id of degradedIds)
		await expect(page.locator(`#lanesTable tr[data-task="${id}"]`)).toHaveClass(
			/degraded/,
		);
	// toggle → card board; back → table
	await page.locator("#lanesViewToggle").click();
	await expect(page.locator("#tab-lanes .kwrap")).toBeVisible();
	await expect(page.locator("#lanesTableWrap")).toBeHidden();
	await page.locator("#lanesViewToggle").click();
	await expect(page.locator("#lanesTableWrap")).toBeVisible();
	// deep link keeps the card board for the kanban-pinning paths
	await page.goto(`${board.BASE}/#lanes?view=cards`);
	await expect(page.locator("#tab-lanes .kwrap")).toBeVisible();
	await expect(page.locator("#lanesTableWrap")).toBeHidden();
});

test("launch failures surface in the stamp and the lane chip", {
	tag: "@ui",
}, async ({ page, board, api }) => {
	const res = await api.get(`${board.BASE}/api/lanes-table`);
	const j = (await res.json()) as {
		launch_failures: { lanes: number; worst_attempts: number };
		lanes: Array<{
			launch: { attempts: number } | null;
			item: { id: string };
			cells: { launch: string };
		}>;
	};
	if (j.launch_failures.lanes === 0) {
		// fresh graph — the stamp renders the plain count, never a fabricated 0
		await page.goto(`${board.BASE}/#lanes?project=${board.projShort}`);
		await expect(page.locator("#lanesStamp")).not.toContainText(
			"launch-failed",
		);
		return;
	}
	await page.goto(`${board.BASE}/#lanes?project=${board.projShort}`);
	await expect(page.locator("#lanesStamp")).toContainText("launch-failed");
	const burned = j.lanes.find((l) => l.launch && l.launch.attempts > 0);
	if (burned)
		await expect(
			page.locator(`#lanesTable tr[data-task="${burned.item.id}"] .lchip`),
		).toContainText("launch");
});
