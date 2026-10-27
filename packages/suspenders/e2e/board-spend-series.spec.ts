// e2e/board-spend-series.spec.ts — W887: the lanes kanban renders the
// per-item micro-strip (sparkline + wall · tok/m · cache%) against a REAL
// board + REAL buckle ledger. Mirrors hub-board.spec.ts's startBoard
// harness: scratch HOME + repo, OS-picked port, dead loopback upstreams.
// The ledger rides SUSPENDERS_BUCKLE_DB="" (spoke-home resolution) so the
// ambient env pin can never leak into the fixture (W670 doctrine).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { startBoard } from "./harness.ts";
import { measureSpark } from "./spark-geom.ts";

// W1203: no serial mode — the tests below share the beforeAll board but no
// mutable state, so a failure in one must not skip the others.
let b: Awaited<ReturnType<typeof startBoard>>;
let wId = "";

test.beforeAll(async () => {
	b = await startBoard("w887", { env: { SUSPENDERS_BUCKLE_DB: "" } });
	wId = b.mintedId(b.workOk(["add", "spend series item"], "add"));
	// the claim window is the attribution input: claim as the lane sid the
	// ledger keys its spend to
	b.workOk(["take", wId, "--as", "autow887-x"], "take");
	const ledger = join(b.HOME, ".claude/local-llm/buckle.db");
	mkdirSync(dirname(ledger), { recursive: true });
	const d = new Database(ledger);
	// the hourly attribution feed rides router_usage+api_keys (W635) while the
	// per-request series (W887) reads route_audit — the fixture feeds both
	d.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	d.run(
		"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0)",
	);
	d.run("INSERT INTO api_keys VALUES ('k1', 'autow887-x')");
	d.run(
		"INSERT INTO router_usage VALUES (?, 'k1', 'glm-5.3-flash', 'glm-5.3-flash', 500, 100, 50, 10, 3)",
		[`${new Date().toISOString().slice(0, 13)}:00`],
	);
	// W1294.2: the per-request series reads route_audit (lane-stamped rows)
	d.run(
		"CREATE TABLE route_audit (ts TEXT, lane TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER)",
	);
	d.run("INSERT INTO route_audit VALUES (?, 'autow887-x', 500, 100, 50, 10)", [
		new Date().toISOString(),
	]);
	d.close();
});

test.afterAll(async () => {
	await b.stop();
});

test("api: spend-series attributes the claimed item's ledger row", {
	tag: "@ui",
}, async () => {
	const r = await fetch(`${b.BASE}/api/spend-series`).then((r) => r.json());
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
}, async ({ page }) => {
	await page.goto(`${b.BASE}/#lanes`);
	// the strip text (fresh 500 · cached 60 → 11% cache) rides the card
	await expect(page.locator(".kspend .kspendtxt")).toContainText("tok/m", {
		timeout: 20_000,
	});
	await expect(page.locator(".kspend .kspendtxt")).toContainText("% cache");
	// the sparkline painted as inline SVG (stacked fresh + cached bars)
	await expect(
		page.locator(".kspark svg rect.spark-fresh").first(),
	).toBeVisible();
	await expect(
		page.locator(".kspark svg rect.spark-cached").first(),
	).toBeVisible();
	// W2060: the drawn svg spans the plot container's real width (no fixed 180)
	const widths = await page.evaluate(() => {
		const plot = document.querySelector(".ksparkplot");
		const svg = plot?.querySelector("svg");
		return {
			plot: plot?.clientWidth ?? 0,
			drawn: svg ? Number(svg.getAttribute("width")) : 0,
		};
	});
	expect(widths.plot).toBeGreaterThan(0);
	expect(widths.drawn).toBe(widths.plot);
	// the tasks table carries the strip as the tok cell tooltip
	await page.goto(`${b.BASE}/#tasks`);
	await expect(
		page.locator('#tasksBody td.num[title*="tok/m"]').first(),
	).toContainText(/\d/);
});

// W1203: bars derive bins + window from the MEASURED track — edge-to-edge
// tiling at default and narrow widths, fixed pixel bars, no stretching.
test("gui: spark bars span the measured track edge-to-edge at both widths", async ({
	page,
}) => {
	// 24h of 1-minute points — every bin ≥3min wide holds data, so the bar
	// count IS the measured bin count and the newest point rides the last bin.
	const t0 = Date.now() - 1440 * 60_000;
	const pts = Array.from({ length: 1441 }, (_, i) => [
		t0 + i * 60_000,
		400 + (i % 7),
		50,
		20,
	]);
	// the board's own key for the item (project half = its project identity)
	const live = await fetch(`${b.BASE}/api/spend-series`).then((r) => r.json());
	const key =
		Object.keys(live.series as Record<string, unknown>).find((k) =>
			k.endsWith(`\u0000${wId}`),
		) ?? `${b.MY_PROJ}\u0000${wId}`;
	await page.route("**/api/spend-series", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ ok: true, series: { [key]: pts } }),
		}),
	);
	await page.goto(`${b.BASE}/#lanes`);
	// the series paints after an async fetch — measure only once bars exist
	await expect(
		page.locator(`.kcard[data-kid="${wId}"] .kspark svg rect`).first(),
	).toBeVisible();
	const card = await measureSpark(page, `.kcard[data-kid="${wId}"]`);
	// no dead gap: the svg tiles the track and both edge bars hug the edges
	expect(Math.abs(card.svgW - card.trackW)).toBeLessThanOrEqual(0.6);
	expect(card.barCount).toBe(Math.floor(card.spanW / 6));
	for (const w of card.barWidths)
		expect(Math.abs(w - 4)).toBeLessThanOrEqual(0.6); // fixed pixel bars
	expect(card.firstLeft).toBeGreaterThanOrEqual(0.5);
	expect(card.firstLeft).toBeLessThanOrEqual(2);
	expect(card.trackW - card.lastRight).toBeGreaterThanOrEqual(0.5);
	expect(card.trackW - card.lastRight).toBeLessThanOrEqual(2);
	expect(card.axisLabel).toBe(card.axisExpected); // labels from actual span
	// drawer cluster rides the same rule at its wider track (5px bars)
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
