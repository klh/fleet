// e2e/board-kanban-card-integration.e2e.ts — W2267.4.2.2: the REAL feed →
// assembled host cards integration (root #103059/#103088/#103097/#103104).
// Seeds a REAL scratch world through the work CLI + a REAL buckle ledger
// (route_audit + router_usage join — board-spend-series pattern) and proves:
// every /api/tasks task renders a valid klh-task-card via the host (zero
// .kcard-invalid), the real execution shape (observed_at NUMBER, progress
// null — #103059's drift class) parses and paints as context, the fail-loud
// boundary still fires on a malformed payload, the ONE strip renders spend
// bars with positive SVG geometry + visible compact axis + 1px hairline,
// Spend→Attempt→Spend swaps mode in the SAME node across polls, and the
// assembled Recover button returns the item to READY without opening the
// drawer (composed-click fallthrough, #103104) or dispatching.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Board } from "../test/helpers/board-harness";
import { expect, test } from "./fixtures";

test.use({
	cleanBoardOptions: { env: { SUSPENDERS_BUCKLE_DB: "" } },
	boardOptions: { env: { SUSPENDERS_BUCKLE_DB: "" } },
});

interface WireTask {
	id: string;
	project: string;
	state: string;
	execution?: {
		state: string;
		observed_at: number;
		source: string | null;
		progress: null | { stage: string; ts: number };
	};
}

/** Mint one item + claim it + seed its ledger row (both ledger faces —
 *  series reads route_audit, card totals read the router_usage join). */
function seedLedgerClaimed(b: Board, n: number): string {
	const wId = b.mintedId(b.workOk(["add", `integration item ${n}`], "add"));
	const sid = `autointeg-${n}`;
	b.workOk(["take", wId, "--as", sid], "take");
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

/** FAILED item: state stamp + work.failed event (recovery-spec pattern). */
function seedFailed(b: Board, title: string): string {
	const id = b.mintedId(b.workOk(["add", title], `mint ${title}`));
	const db = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	const row = db
		.query("SELECT project FROM work_items WHERE id = ?")
		.get(id) as { project: string };
	db.query("UPDATE work_items SET state='FAILED' WHERE project=? AND id=?").run(
		row.project,
		id,
	);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, 'fixture', 'work.failed', NULL, ?)",
	).run(Date.now(), JSON.stringify({ work: id, project: row.project }));
	db.close();
	return id;
}

async function wireTasks(board: Board): Promise<WireTask[]> {
	const r = await fetch(`${board.BASE}/api/tasks`).then((r) => r.json());
	expect(r.ok).toBe(true);
	return r.tasks as WireTask[];
}

async function openLanes(page: Page, board: Board): Promise<void> {
	await page.goto(`${board.BASE}/#lanes`);
	await expect(page.locator("klh-task-card-host").first()).toBeVisible({
		timeout: 20_000,
	});
}

const hostOf = (page: Page, id: string): Locator =>
	page.locator(`klh-task-card-host[data-kid="${id}"]`).first();

/** strip node identity: stamp + re-read proves the SAME element survived. */
const stripStamp = (host: Locator, mark: string): Promise<boolean> =>
	host.evaluate((el, m) => {
		const strip = el.querySelector("klh-card-activity");
		if (!strip) return false;
		strip.setAttribute("data-idmark", m);
		return true;
	}, mark);
const stripIsStampped = (host: Locator, mark: string): Promise<boolean> =>
	host.evaluate(
		(el, m) =>
			el.querySelector("klh-card-activity")?.getAttribute("data-idmark") === m,
		mark,
	);

test("real /api/tasks payload renders every assembled card valid", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const ready = cleanBoard.mintedId(
		cleanBoard.workOk(["add", "integration ready item"], "add"),
	);
	const claimed = seedLedgerClaimed(cleanBoard, 1);
	const failed = seedFailed(cleanBoard, "integration failed item");
	const tasks = await wireTasks(cleanBoard);
	expect(tasks.length).toBeGreaterThanOrEqual(3);
	// #103059's exact drift class, asserted at the wire: the real feed
	// carries execution.observed_at as an epoch-ms NUMBER and progress null
	// for claim-only items — the client schema must accept THIS shape.
	const withExec = tasks.find((t) => t.execution);
	expect(withExec, "no task carried an execution join").toBeTruthy();
	expect(typeof withExec?.execution?.observed_at).toBe("number");
	expect(withExec?.execution?.progress).toBeNull();
	// #103176: the ONE registration entry actually serves + defines all
	// three elements — a 404 here leaves every host :not(:defined)
	const reg = await page.request.get(
		`${cleanBoard.BASE}/vendor/klh-board-register.js`,
	);
	expect(reg.status()).toBe(200);
	expect(reg.headers()["content-type"]).toContain("text/javascript");
	await openLanes(page, cleanBoard);
	await expect(page.locator("klh-task-card-host").first()).toBeVisible({
		timeout: 20_000,
	});
	const defined = await page.evaluate(() => ({
		host: !!customElements.get("klh-task-card-host"),
		card: !!customElements.get("klh-task-card"),
		strip: !!customElements.get("klh-card-activity"),
	}));
	expect(defined).toEqual({ host: true, card: true, strip: true });
	const hosts = page.locator("klh-task-card-host");
	await expect(hosts).toHaveCount(tasks.length, { timeout: 20_000 });
	// every assembled card parsed: zero honest-invalid notes on a real feed
	await expect(page.locator("klh-task-card-host .kcard-invalid")).toHaveCount(
		0,
	);
	// the three states really assembled (shadow card rendered per state)
	for (const id of [ready, claimed, failed]) {
		await expect(hostOf(page, id).locator("klh-task-card .tid")).toContainText(
			id,
			{ timeout: 20_000 },
		);
	}
	// the execution join paints as the claimed card's context line — the
	// harness claim carries no lane registry, so the observed state is
	// "unknown"/"inactive" with honest no-artifact wording
	await expect(
		hostOf(page, claimed).locator("klh-task-card .ctx"),
	).toContainText(/unknown|inactive|live-harness|paused/, { timeout: 20_000 });
	// fail-loud boundary intact: a malformed payload renders the honest
	// note instead of laundering a card
	await hostOf(page, ready).evaluate((el) => {
		el.t = { id: "Wbad", state: 42 };
	});
	await expect(page.locator("klh-task-card-host .kcard-invalid")).toHaveCount(
		1,
	);
});

test("ONE strip: spend bars (real ledger) → attempt segments → spend, node kept", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const wId = seedLedgerClaimed(cleanBoard, 2);
	await openLanes(page, cleanBoard);
	const host = hostOf(page, wId);
	await expect(host).toBeVisible({ timeout: 20_000 });
	// exactly ONE strip per card — never a second timeline
	await expect(host.locator("klh-card-activity")).toHaveCount(1, {
		timeout: 20_000,
	});
	// spend mode: real-ledger bars painted with POSITIVE geometry
	const bars = host.locator("klh-card-activity rect.spark-fresh");
	await expect(bars.first()).toBeVisible({ timeout: 20_000 });
	expect(await bars.count()).toBeGreaterThanOrEqual(1);
	const barBox = await bars.first().boundingBox();
	expect(barBox).toBeTruthy();
	expect(barBox?.width ?? 0).toBeGreaterThan(0);
	expect(barBox?.height ?? 0).toBeGreaterThan(0);
	// compact axis visible (HH:mm window ends + tz · bin) and the 1px
	// duration hairline (root confirmed height 1/axis 12 on this rig)
	const axis = host.locator("klh-card-activity .axis");
	await expect(axis).toBeVisible();
	expect(await axis.textContent()).toMatch(/\d{2}:\d{2}/);
	const hair = host.locator("klh-card-activity .hairline");
	if (await hair.count()) {
		const hb = await hair.first().boundingBox();
		expect(hb?.height ?? 0).toBeLessThanOrEqual(1.5);
	}
	// node identity BEFORE the mode swaps
	expect(await stripStamp(host, "i1")).toBe(true);
	// → attempt mode: same strip element, real firstbyte+tool segments
	await page.click("#attemptView");
	await expect(page.locator('#attemptView[aria-pressed="true"]')).toBeVisible();
	const segs = host.locator(
		"klh-card-activity rect.at-firstbyte, klh-card-activity rect.at-tool",
	);
	await expect(segs.first()).toBeVisible({ timeout: 20_000 });
	expect(await segs.count()).toBeGreaterThanOrEqual(2);
	await expect(host.locator("klh-card-activity")).toHaveCount(1);
	// → back to spend: the same node, spend bars again, attempt rects gone
	await page.click("#attemptView");
	await expect(
		page.locator('#attemptView[aria-pressed="false"]'),
	).toBeVisible();
	await expect(bars.first()).toBeVisible({ timeout: 20_000 });
	await expect(host.locator("klh-card-activity rect.at-tool")).toHaveCount(0);
	// poll survival: feeds ticks land; the SAME strip + host nodes remain
	await page.waitForTimeout(2600);
	expect(await stripIsStampped(host, "i1")).toBe(true);
	await expect(page.locator("klh-task-card-host .kcard-invalid")).toHaveCount(
		0,
	);
	await page.screenshot({
		path: "e2e/test-results/w2267-4-2-2-integration.png",
		fullPage: false,
	});
});

test("assembled Recover → READY: no drawer, no dispatch (#103104)", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const id = seedFailed(cleanBoard, "integration recover probe");
	await openLanes(page, cleanBoard);
	const host = hostOf(page, id);
	await expect(host).toBeVisible({ timeout: 20_000 });
	// the card's shadow footer Recover button (Playwright pierces shadow)
	const recover = host.locator("klh-task-card button.seg.recover");
	await expect(recover).toBeVisible();
	await recover.click();
	// the toast confirms; the drawer NEVER opened (composed-click fix)
	await expect(page.locator("#toasts .toast").first()).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.locator("#drawer")).toBeHidden();
	// the card moved to the READY column on the next poll
	await expect(
		page.locator(
			`.kcol[data-kcol-key="READY"] klh-task-card-host[data-kid="${id}"]`,
		),
	).toBeVisible({ timeout: 20_000 });
	const db = new Database(
		`${cleanBoard.HOME}/.cache/claude-governor/governor.db`,
	);
	db.run("PRAGMA busy_timeout = 4500");
	const row = db
		.query("SELECT state, owner_sid FROM work_items WHERE id = ?")
		.get(id) as { state: string; owner_sid: string | null };
	const dispatched = db
		.query(
			"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.claimed' AND ts > ?",
		)
		.get(Date.now() - 120_000) as { n: number };
	db.close();
	expect(row.state).toBe("READY");
	expect(row.owner_sid).toBeNull();
	// recover requeues only — no dispatch leg fired for this click
	expect(dispatched.n).toBe(0);
});

test("unsubmitted drafts survive an unrelated recovery (root #103404)", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const ready = cleanBoard.mintedId(
		cleanBoard.workOk(["add", "draft probe ready item"], "add"),
	);
	const failed = seedFailed(cleanBoard, "draft probe failed item");
	await openLanes(page, cleanBoard);
	const host = hostOf(page, ready);
	await expect(host).toBeVisible({ timeout: 20_000 });
	// pick codex + medium on the READY card (draft only — never submitted)
	const execSel = `klh-task-card select.seg[aria-label="executor for ${ready}"]`;
	await host.locator(execSel).selectOption("codex");
	const effortSel = `klh-task-card select.seg[aria-label="reasoning effort for ${ready}"]`;
	await host.locator(effortSel).selectOption("medium");
	// the unrelated recovery: FAILED → READY is structural, the kanban
	// rebuild recreates EVERY host (the draft died here before)
	const failedHost = hostOf(page, failed);
	await failedHost.locator("klh-task-card button.seg.recover").click();
	await expect(
		page.locator(
			`.kcol[data-kcol-key="READY"] klh-task-card-host[data-kid="${failed}"]`,
		),
	).toBeVisible({ timeout: 20_000 });
	// the probe card rebuilt — its selects re-hydrate the banked draft
	await expect(host.locator(execSel)).toHaveValue("codex");
	await expect(host.locator(effortSel)).toHaveValue("medium");
});
