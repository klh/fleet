// W1136: rides the shared fixtures — cleanBoard (fresh world per test,
// BUCKLE_DB pinned via cleanBoardOptions to a seeded scratch ledger) + the
// auto pageWatcher; the beforeAll(startBoard) copy is gone.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { Ledger } from "../../buckle/src/ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "network-hours-"));
const ledgerPath = join(dir, "buckle.db");
new Ledger(ledgerPath).close();
const db = new Database(ledgerPath);
const hour = `${new Date().toISOString().slice(0, 13)}:00`;
const insert = db.query(
	"INSERT INTO router_usage (hour_bucket, key, model_group, model, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
insert.run(hour, "a", "glm", "glm-a", 10, 20, 1);
insert.run(hour, "b", "claude", "claude-b", 30, 40, 2);
db.close();
test.use({
	cleanBoardOptions: { env: { BUCKLE_DB: ledgerPath } },
});

test.afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("Gateway shows one measured bar per hour, with summed request rows", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/console/buckle`);
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
