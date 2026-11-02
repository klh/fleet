// e2e/board-recovery-actions.spec.ts — W2267.3: the distinct board recovery
// actions in a REAL browser. Recover → Ready requeues only; Retry requests a
// fresh attempt through the /api/start path. Proves: the action buttons work
// on the FAILED card, the response refreshes the board via the normal poll
// (card leaves the failed column), pending/error UI renders without console
// errors, an action click never opens the task drawer, the actions are
// keyboard-reachable, and the retry leg really claims the item (real git
// world, harness stub carrier). Isolation: board.workOk mints through the
// harness pinned fixture HOME (never the runner env — the
// coord-child-store-binding lesson; a bare execSync here once minted into
// the LIVE store). Rides the shared fixtures (worker board + pageWatcher).

import { Database } from "bun:sqlite";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

interface Board {
	BASE: string;
	HOME: string;
	workOk: (args: string[], why: string) => string;
}

/** Seed one FAILED item in the board ISOLATED scratch world; returns
 *  [id, project] — the project string is whatever identity the CLI stamped
 *  (real git world: "<root>/.git"), never assumed. */
async function seedFailed(
	board: Board,
	title: string,
): Promise<[string, string]> {
	const out = board.workOk(["add", title], `mint ${title}`);
	const id = /\b(W\d+)\b/.exec(out)?.[1];
	if (!id) throw new Error(`no work id minted: ${out}`);
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
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
	return [id, row.project];
}

async function openLanes(page: Page, board: Board) {
	// default project scope is "all" — the scratch world's cards render
	// without touching #proj (the kanban families-spec pattern), so the spec
	// never depends on the .git-suffixed project string
	await page.goto(`${board.BASE}/#lanes`);
}

function failedCard(page: Page, id: string) {
	return page.locator(`.kcard[data-kid="${id}"]`).first();
}

test("recover → Ready requeues only; the card moves columns on the next poll", {
	tag: "@ui",
}, async ({ page, board }) => {
	const [id, proj] = await seedFailed(board, "w2267 browser recover probe");
	await openLanes(page, board);
	const card = failedCard(page, id);
	await expect(card).toBeVisible();
	// the client seam the card lane's footer rides (action API contract)
	await page.evaluate(
		(p) => window.__klhRecovery.recoverItem(p.id, p.proj, null, false),
		{ id, proj },
	);
	// pending UI → response toast → the poll moves the card into READY
	await expect(page.locator("#toasts .toast").first()).toBeVisible({
		timeout: 10_000,
	});
	await expect(
		page.locator(`.kcol[data-kcol-key="READY"] .kcard[data-kid="${id}"]`),
	).toBeVisible({ timeout: 15_000 });
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	const row = db
		.query("SELECT state, owner_sid FROM work_items WHERE id = ?")
		.get(id) as { state: string; owner_sid: string | null };
	db.close();
	expect(row.state).toBe("READY");
	expect(row.owner_sid).toBeNull();
});

test("retry click: toast, no drawer, the fresh attempt really claims the item", {
	tag: "@ui",
}, async ({ page, board }) => {
	const [id, proj] = await seedFailed(board, "w2267 browser retry probe");
	await openLanes(page, board);
	const card = failedCard(page, id);
	await expect(card).toBeVisible();
	await card.locator("button[data-retry]").click();
	// an action click never falls through to the card-open handler
	await expect(page.locator("#drawer")).toBeHidden();
	await expect(page.locator("#toasts .toast").first()).toBeVisible({
		timeout: 10_000,
	});
	// the fresh attempt claims the item (stub carrier exits 0 — no real
	// lane). owner_sid can lose the race to claim cleanup, so the durable
	// proof is the retained work.claimed record for THIS attempt.
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	let by: string | null = null;
	for (let i = 0; i < 60 && !by; i++) {
		await page.waitForTimeout(500);
		by =
			(
				db
					.query(
						"SELECT payload FROM events WHERE kind = 'work.claimed' AND project = ? AND work = ? ORDER BY id DESC LIMIT 1",
					)
					.get(proj, id) as { payload: string | null } | null
			)?.payload ?? null;
	}
	db.close();
	expect(by).toBeTruthy();
	expect(by).toContain(id);
});

test("FAILED-card actions are keyboard reachable", {
	tag: "@ui",
}, async ({ page, board }) => {
	const [id] = await seedFailed(board, "w2267 browser keyboard probe");
	await openLanes(page, board);
	const card = failedCard(page, id);
	await expect(card).toBeVisible();
	const btn = card.locator("button[data-retry]");
	await btn.focus();
	await expect(btn).toBeFocused();
	expect(await btn.getAttribute("type")).toBe("button");
});
