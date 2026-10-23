// e2e/w998-3-volatile-signature.spec.ts — W998.3: an age-only refresh must
// NOT rebuild the work card — the same DOM nodes survive, keyboard focus and
// hover state persist across the 1Hz volatile refresh, and the ages still
// tick in place; a real status/product change (claim move, new card) still
// re-renders. W998.3.1: a rename containing the '· observed' marker is a
// REAL structural change — the W998.3 global marker regex normalized it
// away (identical signature, stale title forever); the live board must
// rebuild and show the new title. Real board + scratch HOME via the
// startBoard harness (w998-card-drawer.spec.ts pattern).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { startBoard } from "./harness.ts";

test.describe.configure({ mode: "serial" });

let b: Awaited<ReturnType<typeof startBoard>>;

test.beforeAll(async () => {
	b = await startBoard("w998-3", {});
});

test.afterAll(async () => {
	await b.stop();
});

test("gui: age-only refresh keeps the card node, keyboard focus and hover while ages tick", async ({
	page,
}) => {
	const wId = b.mintedId(b.workOk(["add", "w998.3 volatile age item"], "add"));
	b.workOk(["take", wId, "--as", "autow998-3-e2e"], "take");
	await page.goto(`${b.BASE}/#lanes`);
	const card = page.locator(`.kcard[data-kid="${wId}"]`).first();
	await expect(card).toBeVisible({ timeout: 20_000 });
	// keyboard focus on the card's id button, pointer parked on the card
	const btn = card.locator(".tidbtn").first();
	await btn.focus();
	await expect(btn).toBeFocused();
	await card.hover();
	// capture the LIVE nodes + starting age label
	await page.evaluate((id) => {
		const w = window as unknown as {
			__w9983?: { card: Element; btn: Element };
		};
		w.__w9983 = {
			card: document.querySelector(`.kcard[data-kid="${id}"]`) as Element,
			btn: document.querySelector(
				`.kcard[data-kid="${id}"] .tidbtn`,
			) as Element,
		};
	}, wId);
	const kage = card.locator(".kage").first();
	const kage0 = await kage.textContent();
	// ≥3 one-second ticks: pollTasks → renderKanban → in-place volatile refresh
	await page.waitForTimeout(3200);
	const after = await page.evaluate((id) => {
		const w = window as unknown as {
			__w9983?: { card: Element; btn: Element };
		};
		const live = document.querySelector(`.kcard[data-kid="${id}"]`);
		return {
			sameCard: live === w?.__w9983.card,
			sameBtn:
				document.querySelector(`.kcard[data-kid="${id}"] .tidbtn`) ===
				w?.__w9983.btn,
			connected: w?.__w9983.card?.isConnected ?? false,
			stillFocused: document.activeElement === w?.__w9983.btn,
			hover:
				(w?.__w9983.card as HTMLElement | null | undefined)?.matches(
					":hover",
				) ?? false,
			ksig: document.getElementById("kanban")?.getAttribute("data-ksig") ?? "",
		};
	}, wId);
	// DOM identity: the volatile refresh replaced NOTHING
	expect(after.sameCard).toBe(true);
	expect(after.sameBtn).toBe(true);
	expect(after.connected).toBe(true);
	// keyboard focus survived the refresh untouched
	expect(after.stillFocused).toBe(true);
	// hover state survived too
	expect(after.hover).toBe(true);
	// the refresh actually ran: the age label ticked at second granularity,
	// while the structural signature stayed put (no rebuild happened)
	expect(after.ksig).not.toBe("");
	const kage1 = await kage.textContent();
	expect(kage1).not.toBe(kage0);
	expect(kage1).toMatch(/^\d+s$/);
});

test("gui: real status and product changes still render", async ({ page }) => {
	const wId = b.mintedId(b.workOk(["add", "w998.3 real-change item"], "add"));
	await page.goto(`${b.BASE}/#lanes`);
	const card = page.locator(`.kcard[data-kid="${wId}"]`).first();
	await expect(card).toBeVisible({ timeout: 20_000 });
	// status change: the claim moves the card to the claimed column with the
	// claimed pill — a real structural render, not a volatile refresh (the
	// W891 state letter prefixes the pill word)
	b.workOk(["take", wId, "--as", "autow998-3-e2e"], "take");
	await expect(card.locator(".pill")).toHaveText(/claimed/i);
	// product change: a freshly minted sibling renders as a new card
	const w2 = b.mintedId(b.workOk(["add", "w998.3 real-change sibling"], "add"));
	await expect(page.locator(`.kcard[data-kid="${w2}"]`)).toBeVisible();
});

test("gui: rename containing '· observed' re-renders the stale card title", async ({
	page,
}) => {
	const oldTitle = "rename probe · observed old finding";
	const wId = b.mintedId(b.workOk(["add", oldTitle], "add"));
	await page.goto(`${b.BASE}/#lanes`);
	const card = page.locator(`.kcard[data-kid="${wId}"]`).first();
	await expect(card).toBeVisible({ timeout: 20_000 });
	const title = card.locator(".ktitle");
	await expect(title).toHaveText(oldTitle);
	// hold the pre-rename card node — the rename must be a REAL structural
	// rebuild (fresh node), not a stale card keeping the old title
	await page.evaluate((id) => {
		const w = window as unknown as { __w99831?: { card: Element } };
		w.__w99831 = {
			card: document.querySelector(`.kcard[data-kid="${id}"]`) as Element,
		};
	}, wId);
	// rename the SAME item (scratch graph, board-kanban-column-order pattern)
	const newTitle = "rename probe · observed new finding";
	const db = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	db.query("UPDATE work_items SET title=? WHERE project=? AND id=?").run(
		newTitle,
		b.MY_PROJ,
		wId,
	);
	db.close();
	// the W998.3 global marker regex collapsed both titles to one signature —
	// the card never rebuilt and this expectation timed out; the scoped
	// normalization keeps the rename structural, so the live board shows it
	await expect(title).toHaveText(newTitle, { timeout: 15_000 });
	// and the refresh was a structural rebuild: the held pre-rename node is
	// detached, the live card is a fresh node
	const replaced = await page.evaluate((id) => {
		const w = window as unknown as { __w99831?: { card: Element } };
		const live = document.querySelector(`.kcard[data-kid="${id}"]`);
		return (
			live !== null &&
			live !== w?.__w99831.card &&
			w?.__w99831.card?.isConnected === false
		);
	}, wId);
	expect(replaced).toBe(true);
});
