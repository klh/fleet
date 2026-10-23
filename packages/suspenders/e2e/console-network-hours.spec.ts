import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Ledger } from "../../buckle/src/ledger.ts";
import { startBoard, type Board } from "../test/helpers/board-harness";

let board: Board | null = null;
let dir = "";

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "network-hours-"));
	const path = join(dir, "buckle.db");
	new Ledger(path).close();
	const db = new Database(path);
	const hour = `${new Date().toISOString().slice(0, 13)}:00`;
	const insert = db.query(
		"INSERT INTO router_usage (hour_bucket, key, model_group, model, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	insert.run(hour, "a", "glm", "glm-a", 10, 20, 1);
	insert.run(hour, "b", "claude", "claude-b", 30, 40, 2);
	db.close();
	board = await startBoard("network-hours", { env: { BUCKLE_DB: path } });
});

test.afterAll(async () => {
	if (board) await board.stop();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("Gateway shows one measured bar per hour, with summed request rows", async ({
	page,
}) => {
	if (!board) throw new Error("board not started");
	await page.goto(`${board.BASE}/console/buckle`);
	const card = page.locator("klh-network-card");
	await expect(card.getByText("Recorded output · last 12 hours")).toBeVisible();
	const bars = card.locator(".hourBar");
	await expect(bars).toHaveCount(12);
	const titles = await bars.evaluateAll((items) =>
		items.map((item) => item.getAttribute("title") ?? ""),
	);
	expect(
		titles.filter((title) => title.includes("3 req · out 60 tok")),
	).toHaveLength(1);
	const routes = card.locator("details.routes");
	await expect(routes).toBeVisible();
	await expect(routes).not.toHaveAttribute("open", "");
	await routes.locator("summary").click();
	await expect(routes.getByText("No settled routes yet")).toBeVisible();
});
