// e2e/usage-drilldown.spec.ts — W826: the /usage cache-efficiency drilldown
// rides a REAL fleet-board on an OS-picked port with SUSPENDERS_BUCKLE_DB
// pinned to a fixture ledger — real data, real Lit panel, real fetch chain
// (progressive disclosure: report → lane click → request rows).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBoard, type Board } from "./harness";

let board: Board | null = null;
let ledgerDir: string | null = null;

function mkLedger(): string {
	const dir = mkdtempSync(join(tmpdir(), "sb-e2e-w826-ledger-"));
	ledgerDir = dir;
	const path = join(dir, "buckle.db");
	const db = new Database(path);
	db.run(
		"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT DEFAULT '', dialect TEXT DEFAULT '', target_model TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT, cache_r INTEGER, cache_c INTEGER, decision TEXT DEFAULT '', hop TEXT)",
	);
	db.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	db.run(
		"CREATE TABLE router_usage (hour_bucket TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', model_group TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY (hour_bucket, key, model_group, model))",
	);
	db.run("INSERT INTO api_keys VALUES ('kx', 'laneX')");
	const now = Date.now();
	// laneX: 30 cold rows a minute apart — a 29-long streak story; laneY:
	// 20 warm rows. Fleet warm-rate = 20/50 = 40.0%.
	for (let i = 0; i < 30; i++)
		db.run(
			"INSERT INTO route_audit (rid, ts, lane, dialect, target_model, status, duration_ms, ok, cache_r, cache_c, decision) VALUES (?, ?, 'laneX', 'anthropic', 'glm-5.3-flash', 200, 800, 1, 0, 1200, 'complexity-v3')",
			[`x${i}`, new Date(now - i * 60_000).toISOString()],
		);
	for (let i = 0; i < 20; i++)
		db.run(
			"INSERT INTO route_audit (rid, ts, lane, dialect, target_model, status, duration_ms, ok, cache_r, cache_c, decision) VALUES (?, ?, 'laneY', 'anthropic', 'glm-5.3-flash', 200, 800, 1, 500, 0, 'complexity-v3')",
			[`y${i}`, new Date(now - i * 60_000).toISOString()],
		);
	db.close();
	return path;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	const ledger = mkLedger();
	board = await startBoard("usage-drilldown", {
		env: { SUSPENDERS_BUCKLE_DB: ledger },
	});
});

test.afterAll(async () => {
	if (board) await board.stop();
	if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("report renders: fleet warm-rate, lane rows, bust chips, controls", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/usage`);
	const panel = page.locator("klh-usage-drilldown");
	await expect(panel).toBeVisible();
	await expect(panel.locator("h2")).toHaveText("CACHE EFFICIENCY · 7D");
	await expect(panel.locator(".ufleet")).toContainText("fleet warm-rate 40.0%");
	// laneX row: 30 reqs, 0 warm, all-cold red, streak chip
	const xrow = panel.locator("tbody tr", {
		has: page.locator("td.ulane", { hasText: "laneX" }),
	});
	await expect(xrow.locator("td.unum").first()).toHaveText("30");
	await expect(xrow.locator("td.bad")).toHaveText("0.0%");
	await expect(xrow.locator(".uwhy-r").first()).toHaveText("streak×29");
	await expect(panel.locator("select")).toHaveCount(3);
	expect(errors, "uncaught page exceptions").toEqual([]);
});

test("lane disclosure loads request rows; miss-only refetch cuts to cold", async ({
	page,
}) => {
	await page.goto(`${mustBoard().BASE}/usage`);
	const panel = page.locator("klh-usage-drilldown");
	await expect(panel.locator("table.udrill")).toBeVisible();
	// laneY: 20 warm rows — disclosure shows them; miss-only empties it
	const yrow = panel.locator("tbody tr", {
		has: page.locator("td.ulane", { hasText: "laneY" }),
	});
	await yrow.click();
	const sub = panel.locator("tr.usub");
	await expect(sub).toBeVisible();
	await expect(sub.locator("table.ureq tbody tr")).toHaveCount(20);
	await panel.locator("input[type=checkbox]").check();
	await expect(sub.locator("table.ureq tbody tr")).toHaveCount(0);
	await expect(sub.locator(".ufoot")).toContainText("0 requests");
	// uncheck, then flip to laneX: every row is cold — cap-free full 30
	await panel.locator("input[type=checkbox]").uncheck();
	const xrow = panel.locator("tbody tr", {
		has: page.locator("td.ulane", { hasText: "laneX" }),
	});
	await xrow.click();
	await expect(panel.locator("tr.usub table.ureq tbody tr")).toHaveCount(30);
});
