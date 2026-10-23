// e2e/board-spend-series.spec.ts — W887: the lanes kanban renders the
// per-item micro-strip (sparkline + wall · tok/m · cache%) against a REAL
// board + REAL buckle ledger. Mirrors hub-board.spec.ts's startBoard
// harness: scratch HOME + repo, OS-picked port, dead loopback upstreams.
// The ledger rides SUSPENDERS_BUCKLE_DB="" (spoke-home resolution) so the
// ambient env pin can never leak into the fixture (W670 doctrine).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { startBoard } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

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
	d.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	d.run(
		"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0)",
	);
	d.run("INSERT INTO api_keys VALUES ('k1', 'autow887-x')");
	d.run(
		"INSERT INTO router_usage VALUES (?, 'k1', 'glm-5.3-flash', 'glm-5.3-flash', 500, 100, 50, 10, 3)",
		[`${new Date().toISOString().slice(0, 13)}:00`],
	);
	d.close();
});

test.afterAll(async () => {
	await b.stop();
});

test("api: spend-series attributes the claimed item's ledger row", async () => {
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

test("gui: lanes kanban paints the micro-strip sparkline + strip text", async ({
	page,
}) => {
	await page.goto(`${b.BASE}/#lanes`);
	// the strip text (fresh 500 · cached 60 → 11% cache) rides the card
	await expect(page.locator(".kspend .kspendtxt")).toContainText("tok/m", {
		timeout: 20_000,
	});
	await expect(page.locator(".kspend .kspendtxt")).toContainText("% cache");
	// the sparkline painted as inline SVG (fresh + cached polylines)
	await expect(page.locator(".kspark svg polyline.spark-fresh")).toHaveCount(1);
	await expect(page.locator(".kspark svg polyline.spark-cached")).toHaveCount(
		1,
	);
	// the tasks table carries the strip as the tok cell tooltip
	await page.goto(`${b.BASE}/#tasks`);
	await expect(
		page.locator('#tasksBody td.num[title*="tok/m"]').first(),
	).toContainText(/\d/);
});
