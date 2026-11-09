// e2e/board-density-drawer.e2e.ts — W2267.5 owner density correction (8 Nov
// 2026): the #lanes kanban returned to the original compact density —
// columns ~300–320 CSS px (superseding W2267.4.2.2's 360–420px) — while the
// drawer owns the FULL detail: complete title, description, split context,
// model/executor/host, failure text, and the dependency graph. Pinned:
//   1. every .kcol computed width lands in [300, 320] (clamped track);
//   2. the compact card keeps readable type (ID 18px, title 14px) and the
//      horizontal wrap scroll still absorbs overflow (page never scrolls);
//   3. the drawer renders the COMPLETE title (never the slice(0,70) stub),
//      plus Description / Dependency graph sections and model/host rows;
//   4. attempt view with NO attempt payload but real spend points keeps the
//      spend spectral view (a grey empty band never replaces fine spikes).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test, type Board } from "./fixtures";

// #100627: the board process must NEVER reach the live governor store.
test.use({ boardOptions: { env: { GOVERNOR_STORE_URL: "local" } } });

const LONG_TITLE =
	" OWNER-GATED density correction item with a deliberately long multi-word title that the old drawer sliced at seventy characters and the compact card clamps visually";

/** Mint + describe one item (`work add --desc`). */
function seedDescribed(b: Board, title: string, desc: string): string {
	const id = b.mintedId(
		b.workOk(["add", title, "--desc", desc], `mint ${title}`),
	);
	return id;
}

/** FAILED item: state stamp + work.failed note (recovery-spec pattern). */
function seedFailed(b: Board, title: string, note: string): string {
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
	).run(Date.now(), JSON.stringify({ work: id, project: row.project, note }));
	db.close();
	return id;
}

/** Ledger rows so spend attribution + series exist for a claimed lane. */
function seedLedgerClaimed(b: Board, title: string): string {
	const wId = b.mintedId(b.workOk(["add", title], "add"));
	const sid = `density-${wId}`;
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
	d.run("INSERT OR IGNORE INTO api_keys VALUES (?, ?)", [`k${wId}`, sid]);
	d.run(
		"INSERT INTO router_usage (hour_bucket, key, model_group, model, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, 'glm-5.3', 'glm-5.3', 500, 100, 50, 10, 3)",
		[`${new Date().toISOString().slice(0, 13)}:00`, `k${wId}`],
	);
	d.run("INSERT INTO route_audit VALUES (?, ?, '', 500, 100, 50, 10, 3)", [
		new Date().toISOString(),
		sid,
	]);
	d.close();
	return wId;
}

async function openLanes(page: Page, board: Board): Promise<void> {
	await page.goto(`${board.BASE}/#lanes`);
	await expect(page.locator("klh-task-card-host").first()).toBeVisible({
		timeout: 20_000,
	});
}

const hostOf = (page: Page, id: string): Locator =>
	page.locator(`klh-task-card-host[data-kid="${id}"]`).first();

test("compact columns: every .kcol measures 300–320px", { tag: "@ui" }, async ({
	page,
	cleanBoard,
}) => {
	cleanBoard.workOk(["add", "density ready item"], "add");
	await openLanes(page, cleanBoard);
	const widths = await page.evaluate(() =>
		[...document.querySelectorAll(".kcol")].map((c) =>
			Math.round(c.getBoundingClientRect().width),
		),
	);
	expect(widths.length, "columns rendered").toBeGreaterThanOrEqual(2);
	for (const w of widths)
		expect(
			w,
			`column width ${w} inside the compact 300–320 band`,
		).toBeGreaterThanOrEqual(300);
	for (const w of widths) expect(w).toBeLessThanOrEqual(320);
});

test("compact card type: ID 18px, title 14px, wrap absorbs overflow", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const id = seedDescribed(
		cleanBoard,
		`density card${LONG_TITLE}`,
		"description body",
	);
	await openLanes(page, cleanBoard);
	const host = hostOf(page, id);
	await expect(host).toBeVisible();
	// the host is a LIGHT-DOM bridge (createRenderRoot returns this) — the
	// card is a direct child; only the card's own styles are shadow-scoped.
	// Poll until the inner card upgrades and its shadow DOM exists.
	await expect
		.poll(
			() =>
				host.evaluate((el) => {
					const card = el.querySelector("klh-task-card");
					const root = card?.shadowRoot;
					const tid = root?.querySelector(".tid");
					const title = root?.querySelector(".title");
					return JSON.stringify({
						idPx: tid ? getComputedStyle(tid).fontSize : "",
						titlePx: title ? getComputedStyle(title).fontSize : "",
					});
				}),
			{ timeout: 10_000 },
		)
		.toBe(JSON.stringify({ idPx: "18px", titlePx: "14px" }));
	const scroll = await page.evaluate(() => {
		const wrap = document.querySelector(".kwrap");
		return {
			wrapScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
			docScrolls:
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		};
	});
	if (scroll.wrapScrolls) expect(scroll.docScrolls).toBe(false);
});

test("drawer: complete title, description, dependency graph, model rows", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const dep = cleanBoard.mintedId(
		cleanBoard.workOk(["add", "density dependency item"], "dep"),
	);
	const parent = seedDescribed(
		cleanBoard,
		`density drawer${LONG_TITLE}`,
		"first line of the description\nsecond line survives pre-wrap",
	);
	// one dep edge + one split child: the graph section has real rows
	cleanBoard.workOk(["add", "density child item", "--parent", parent], "child");
	const dbPath = `${cleanBoard.HOME}/.cache/claude-governor/governor.db`;
	const db = new Database(dbPath);
	db.run("PRAGMA busy_timeout = 4500");
	const proj = (
		db.query("SELECT project FROM work_items WHERE id = ?").get(parent) as {
			project: string;
		}
	).project;
	db.query(
		"INSERT INTO work_deps (project, work_id, depends_on) VALUES (?, ?, ?)",
	).run(proj, parent, dep);
	db.close();
	await openLanes(page, cleanBoard);
	await hostOf(page, parent).locator("klh-task-card .tid").click();
	await expect
		.poll(
			() =>
				page
					.locator("#drawerBody .feed h2", {
						hasText: "Description",
					})
					.count(),
			{ timeout: 10_000 },
		)
		.toBeGreaterThanOrEqual(1);
	const drawer = await page.evaluate(() => {
		const title = document.querySelector("#drawerTitle")?.textContent ?? "";
		const body = document.querySelector("#drawerBody")?.textContent ?? "";
		return { title, body };
	});
	expect(drawer.title).toContain(LONG_TITLE.trim());
	expect(drawer.body).toContain("second line survives pre-wrap");
	expect(drawer.body).toContain("Dependency graph");
	expect(drawer.body).toContain(dep);
	// the child id renders in the graph section
	const childId = await page.evaluate(() => {
		const rows = [...document.querySelectorAll("#drawerBody .r")];
		const kids = rows.find((r) => r.textContent?.startsWith("children"));
		return kids?.textContent ?? "";
	});
	expect(childId).toMatch(/^children\s+W/);
});

test("drawer: FAILED card opens with full failure note", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const note = "the honest failure reason — three attempts, tree restored";
	const id = seedFailed(cleanBoard, "density failed item", note);
	await openLanes(page, cleanBoard);
	await hostOf(page, id).locator("klh-task-card .tid").click();
	await expect(page.locator("#drawerBody")).toContainText(note);
});

test("attempt view keeps the spend truth view when no attempt payload", {
	tag: "@ui",
}, async ({ page, cleanBoard }) => {
	const id = seedLedgerClaimed(cleanBoard, "density spend item");
	await openLanes(page, cleanBoard);
	const host = hostOf(page, id);
	await expect(host).toBeVisible();
	// real spend points exist (series poll may take a beat)
	await expect
		.poll(
			async () =>
				host.evaluate((el) => {
					const strip = el.querySelector("klh-card-activity");
					return strip?.points?.length ?? 0;
				}),
			{ timeout: 15_000 },
		)
		.toBeGreaterThan(0);
	// toggle attempt view; this lane has NO attempt timeline
	await page.locator("#attemptView").click();
	await page.waitForTimeout(600);
	const mode = await host.evaluate((el) => {
		const strip = el.querySelector("klh-card-activity");
		const root = strip?.shadowRoot;
		if (!root) return { plot: false, empty: false };
		return {
			plot: !!root.querySelector("svg.plot"),
			empty: !!root.querySelector(".attempt-empty"),
		};
	});
	expect(mode.plot, "spend spectral plot stays (no grey empty band)").toBe(
		true,
	);
	expect(mode.empty).toBe(false);
});
