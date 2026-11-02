// e2e/board-spend-series.spec.ts — W887: the lanes kanban renders the
// per-item micro-strip (sparkline + wall · tok/m · cache%) against a REAL
// board + REAL buckle ledger. Mirrors hub-board.spec.ts's startBoard
// harness: scratch HOME + repo, OS-picked port, dead loopback upstreams.
// The ledger rides SUSPENDERS_BUCKLE_DB="" (spoke-home resolution) so the
// ambient env pin can never leak into the fixture (W670 doctrine).
// W1136: rides the shared fixtures — worker board (SUSPENDERS_BUCKLE_DB
// pinned via boardOptions), the api fixture (no raw fetch), per-test ledger
// seeds with per-test keys, and the auto pageWatcher; the
// beforeAll(startBoard) copy is gone.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Board } from "../test/helpers/board-harness";
import { expect, test } from "./fixtures";
import { measureSpark } from "./spark-geom";

test.use({ boardOptions: { env: { SUSPENDERS_BUCKLE_DB: "" } } });

/** Seed one claimed item + its ledger row on the board (per-test key). */
function seedSpend(b: Board, n: number): string {
	const wId = b.mintedId(b.workOk(["add", `spend series item ${n}`], "add"));
	// the claim window is the attribution input: claim as the lane sid the
	// ledger keys its spend to
	const sid = `autow1136-${n}`;
	b.workOk(["take", wId, "--as", sid], "take");
	// W1136: the series reads the route_audit ledger (laneRequestSpendRows);
	// the kanban strip totals read the hourly router_usage⋈api_keys join
	// (laneSpendRows/itemAttribution) — seed BOTH faces with the same numbers
	const ledger = join(b.HOME, ".claude/local-llm/buckle.db");
	mkdirSync(dirname(ledger), { recursive: true });
	const d = new Database(ledger);
	d.run(
		"CREATE TABLE IF NOT EXISTS api_keys (key_id TEXT PRIMARY KEY, name TEXT)",
	);
	d.run(
		"CREATE TABLE IF NOT EXISTS router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0)",
	);
	d.run(
		"CREATE TABLE IF NOT EXISTS route_audit (ts TEXT, lane TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, latency_ms INTEGER DEFAULT 0)",
	);
	d.run("INSERT OR IGNORE INTO api_keys VALUES (?, ?)", [`k${n}`, sid]);
	d.run(
		"INSERT INTO router_usage (hour_bucket, key, model_group, model, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, 'glm-5.3-flash', 'glm-5.3-flash', 500, 100, 50, 10, 3)",
		[`${new Date().toISOString().slice(0, 13)}:00`, `k${n}`],
	);
	d.run("INSERT INTO route_audit VALUES (?, ?, '', 500, 100, 50, 10, 3)", [
		new Date().toISOString(),
		sid,
	]);
	d.close();
	return wId;
}

test("api: spend-series attributes the claimed item's ledger row", {
	tag: "@ui",
}, async ({ board, api }) => {
	const wId = seedSpend(board, 1);
	const r = await (await api.get("/api/spend-series")).json();
	expect(r.ok).toBe(true);
	const hit = Object.entries(
		r.series as Record<string, [number, number, number, number][]>,
	).find(([k]) => k.endsWith(`\u0000${wId}`));
	expect(hit, `no series entry for ${wId}`).toBeDefined();
	const pts = hit?.[1] ?? [];
	expect(pts.length).toBeGreaterThan(0);
	expect(pts[0][1]).toBe(500); // fresh (in_tok)
	expect(pts[0][2]).toBe(60); // cached (cache_r + cache_c)
	expect(pts[0][3]).toBe(100); // out
});

test("gui: lanes kanban paints the micro-strip sparkline + strip text", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	// a fresh board process: the spend-series memo boots cold so the seeded
	// item's series is in the FIRST /api/spend-series payload (the worker
	// board's 5s memo still held the api test's W1-only series at goto)
	const wId = seedSpend(cleanBoard, 2);
	await page.goto(`${cleanBoard.BASE}/#lanes`);
	// scope to the seeded card — the worker board may carry earlier claimed
	// items whose strips paint too (strict mode)
	const card = page.locator(`.kcard[data-kid="${wId}"]`);
	// the strip text (fresh 500 · cached 60 → 11% cache) rides the card
	await expect(card.locator(".kspend .kspendtxt")).toContainText("tok/m", {
		timeout: 20_000,
	});
	await expect(card.locator(".kspend .kspendtxt")).toContainText("% cache");
	// the sparkline painted as inline SVG (fresh + cached bars — the
	// renderer draws stacked rect bars, not polylines)
	await expect(card.locator(".kspark svg rect.spark-fresh")).toHaveCount(1);
	await expect(card.locator(".kspark svg rect.spark-cached")).toHaveCount(1);
	// the tasks table carries the strip as the tok cell tooltip
	await page.goto(`${cleanBoard.BASE}/#tasks`);
	await expect(
		page.locator('#tasksBody td.num[title*="tok/m"]').first(),
	).toContainText(/\d/);
});

// W1203: bars derive bins + window from the MEASURED track — edge-to-edge
// tiling at default and narrow widths, fixed pixel bars, no stretching.
test("gui: spark bars span the measured track edge-to-edge at both widths", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	// 24h of 1-minute points — every bin ≥3min wide holds data, so the bar
	// count IS the measured bin count and the newest point rides the last bin.
	const t0 = Date.now() - 1440 * 60_000;
	const pts = Array.from({ length: 1441 }, (_, i) => [
		t0 + i * 60_000,
		400 + (i % 7),
		50,
		20,
	]);
	const wId = seedSpend(cleanBoard, 3);
	// the board owns the key for the item (project half = the project string
	// the tasks feed itself serves — the git-common-dir, .git-suffixed)
	const feed = (await (await fetch(`${cleanBoard.BASE}/api/tasks`)).json()) as {
		tasks: Array<{ id: string; project: string }>;
	};
	const mine = feed.tasks.find((t) => t.id === wId);
	if (!mine) throw new Error(`no tasks row for ${wId}`);
	const key = `${mine.project}\u0000${wId}`;
	await page.route("**/api/spend-series", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ ok: true, series: { [key]: pts } }),
		}),
	);
	await page.goto(`${cleanBoard.BASE}/#lanes`);
	// the series paints after an async fetch — measure only once bars exist
	await expect(
		page.locator(`.kcard[data-kid="${wId}"] .kspark svg rect`).first(),
	).toBeVisible();
	const card = await measureSpark(page, `.kcard[data-kid="${wId}"]`);
	expect(Math.abs(card.svgW - card.trackW)).toBeLessThanOrEqual(0.6);
	expect(card.barCount).toBe(Math.floor(card.spanW / 6));
	for (const w of card.barWidths)
		expect(Math.abs(w - 4)).toBeLessThanOrEqual(0.6); // fixed pixel bars
	expect(card.firstLeft).toBeGreaterThanOrEqual(0.5);
	expect(card.firstLeft).toBeLessThanOrEqual(2);
	expect(card.trackW - card.lastRight).toBeGreaterThanOrEqual(0.5);
	expect(card.trackW - card.lastRight).toBeLessThanOrEqual(2);
	expect(card.axisLabel).toBe(card.axisExpected); // labels from actual span
	await page.locator(`.kcard[data-kid="${wId}"] .tidbtn`).click();
	await expect(
		page.locator("#drawerBody .kspend-drawer .kspark svg rect").first(),
	).toBeVisible();
	const drawer = await measureSpark(page, "#drawerBody");
	expect(drawer.barCount).toBe(Math.floor(drawer.spanW / 6));
	for (const w of drawer.barWidths)
		expect(Math.abs(w - 5)).toBeLessThanOrEqual(0.6); // fixed 5px in drawer
	expect(drawer.firstLeft).toBeGreaterThanOrEqual(0.5);
	expect(drawer.trackW - drawer.lastRight).toBeGreaterThanOrEqual(0.5);
	expect(drawer.trackW - drawer.lastRight).toBeLessThanOrEqual(2);
	expect(drawer.axisLabel).toBe(drawer.axisExpected);
	const wideDrawerTrack = drawer.trackW;
	// narrow/mobile: the drawer re-derives its window from the shrunken panel.
	// Poll on BAR WIDTH: a not-yet-repainted svg CSS-squeezes (max-width:100%)
	// and would pass a width-equality poll — fixed pixels are the contract.
	await page.setViewportSize({ width: 320, height: 800 });
	await expect
		.poll(async () => {
			const g = await measureSpark(page, "#drawerBody");
			return g.barWidths.length > 0 ? Math.abs(g.barWidths[0] - 5) : 99;
		})
		.toBeLessThanOrEqual(0.6);
	const narrow = await measureSpark(page, "#drawerBody");
	expect(narrow.trackW).toBeLessThan(wideDrawerTrack - 10);
	expect(narrow.barCount).toBe(Math.floor(narrow.spanW / 6));
	for (const w of narrow.barWidths)
		expect(Math.abs(w - 5)).toBeLessThanOrEqual(0.6); // bars never stretch
	// the card tiles edge-to-edge too, whatever its track did at 320px
	const cardNarrow = await measureSpark(page, `.kcard[data-kid="${wId}"]`);
	for (const w of cardNarrow.barWidths)
		expect(Math.abs(w - 4)).toBeLessThanOrEqual(0.6);
	expect(cardNarrow.firstLeft).toBeGreaterThanOrEqual(0.5);
	expect(cardNarrow.trackW - cardNarrow.lastRight).toBeLessThanOrEqual(2);
});
