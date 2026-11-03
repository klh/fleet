// e2e/gateway-flow.spec.ts — W2673.2: the live gateway flow card on
// /console/buckle as a committed GUI spec (component law: E2E as spec, not
// one-off screenshots). Rides the shared fixtures — cleanBoard spawns the
// board with BUCKLE_DB (ledger half) + KLH_LANE_ROUTES_DB (projection half)
// pinned at seeded scratch dbs; the card upgrades, renders the three
// columns from the W2673.1 feed, the window selector switches the feed,
// and Live/Pause freezes the payload.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@klh/buckle/src/ledger.ts";
import type { Observation } from "@klh/buckle/src/observe.ts";
import { LaneProjection } from "@klh/buckle/src/projection.ts";
import { expect, test } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "gateway-flow-"));
const obsPath = join(dir, "obs.db");
const ledgerPath = join(dir, "buckle.db");

// projection: companion lane with 6 ended (2 errored) + 1 active; an
// actor-only sender (no lane); a pre-window pair (excluded). Numeric ids
// per source — ingest drops non-digits.
const proj = new LaneProjection(obsPath);
let seq = 0;
const edge = (
	rid: string,
	lane: string,
	actor: string,
	at: number,
	outcome: string | null,
): Observation => ({
	specversion: "1.0",
	type: outcome === null ? "lane.request.admitted" : "lane.request.ended",
	source: "buckle://local/gui",
	id: String(++seq),
	time: new Date(at).toISOString(),
	data: {
		rid,
		lane,
		actor,
		dialect: "anthropic",
		model: "",
		traceparent: `00-${rid.padEnd(32, "0").slice(0, 32)}-0123456789abcdef-01`,
		...(outcome === null ? {} : { outcome, status: 200, attempts: 1 }),
	},
});
const rows: Observation[] = [];
const T0 = Date.now() - 30_000;
// real sid shape (dot-separated worktree) — laneShort renders W2673.2
const LANE = "autow2673.2-p98b319584008df14";
for (let i = 0; i < 6; i++) {
	const rid = `g${i}`;
	rows.push(edge(rid, LANE, "a1", T0 - i * 1000, null));
	rows.push(
		edge(rid, LANE, "a1", T0 - i * 1000 + 500, i < 2 ? "errored" : "policy"),
	);
}
rows.push(edge("ga", "", "actor-x", T0 - 500, null));
rows.push(edge("ga", "", "actor-x", T0 - 100, "policy"));
rows.push(edge("gl", LANE, "a1", T0 - 50, null)); // never ended
proj.ingest(rows);
proj.close();

// ledger: glm-5.3 target rows riding the companion lane's rids
new Ledger(ledgerPath).close();
const led = new Database(ledgerPath);
const insert = led.query(`INSERT INTO route_audit
(rid, ts, lane, actor, dialect, target_kind, target_host, target_model, ok, status, key_name)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (let i = 0; i < 6; i++)
	insert.run(
		`g${i}`,
		new Date(T0 - i * 1000).toISOString(),
		LANE,
		"a1",
		"anthropic",
		"local",
		"127.0.0.1",
		"glm-5.3",
		i < 2 ? 0 : 1,
		i < 2 ? 502 : 200,
		"autow2673.2-p98b319584008df14",
	);
led.close();

test.use({
	cleanBoardOptions: {
		env: { BUCKLE_DB: ledgerPath, KLH_LANE_ROUTES_DB: obsPath },
	},
});

test.afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("gateway flow card renders the three columns from the live feed", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	await page.goto(`${cleanBoard.BASE}/console/buckle`);
	const card = page.locator("klh-gateway-flow-card");
	// upgraded + loaded (the poll landed)
	await expect(card.getByText("window 5m", { exact: false })).toBeVisible({
		timeout: 15_000,
	});
	// columns
	await expect(card.locator(".colTitle", { hasText: "Senders" })).toBeVisible();
	await expect(card.locator(".colTitle", { hasText: "Gateway" })).toBeVisible();
	await expect(card.locator(".colTitle", { hasText: "Targets" })).toBeVisible();
	// sender: the companion lane shortened to the board vocabulary
	await expect(card.getByText("W2673.2")).toBeVisible();
	// the actor-only sender renders its hash, never an empty cell
	await expect(card.getByText("actor-x", { exact: false })).toBeVisible();
	// gateway node: measured window totals (8 admitted: 6 lane + 1 actor + 1 active)
	await expect(card.locator(".gatewayNode").getByText("8 req")).toBeVisible();
	await expect(
		card.locator(".gatewayNode").getByText("1 active"),
	).toBeVisible();
	await expect(card.locator(".gatewayNode").getByText("2 err")).toBeVisible();
	// targets: the MODELS group with the ledger-proven model
	await expect(card.getByText("MODELS")).toBeVisible();
	await expect(
		card.locator(".node .who", { hasText: "glm-5.3" }),
	).toBeVisible();
	// legend carries the edge vocabulary
	await expect(
		card.getByText("dashed = companion", { exact: false }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/gateway-flow-card.png" });
});

test("window selector switches the feed; pause freezes the payload", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	await page.goto(`${cleanBoard.BASE}/console/buckle`);
	const card = page.locator("klh-gateway-flow-card");
	await expect(card.getByText("window 5m", { exact: false })).toBeVisible({
		timeout: 15_000,
	});
	// 1 min still holds the seeded rows (all within 30s)
	await card.locator("select[aria-label='flow window']").selectOption("60");
	await expect(card.getByText("window 1m", { exact: false })).toBeVisible({
		timeout: 15_000,
	});
	await expect(card.locator(".gatewayNode").getByText("8 req")).toBeVisible();
	// pause: the button flips, the payload stays rendered
	await card.locator("button.live").click();
	await expect(card.locator("button.live")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(card.locator(".gatewayNode").getByText("8 req")).toBeVisible();
});
