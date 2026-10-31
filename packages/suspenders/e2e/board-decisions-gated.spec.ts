// e2e/board-decisions-gated.spec.ts — W2310: the decisions drawer renders
// OWNER-GATED and blocked work items with their best-action recommendation
// (payload .gated, the same report row set `work report` emits). Committed
// GUI spec per the E2E-is-the-committed-spec law.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-decisions-gated");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("decisions drawer shows gated items with best-action recommendations", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	const gatedId = b
		.workOk(["add", "OWNER-GATED: gated probe item"], "seed gated item")
		.match(/W\d+/)?.[0];
	const blockedId = b
		.workOk(["add", "plain probe item"], "seed blocked item")
		.match(/W\d+/)?.[0];
	if (!gatedId || !blockedId) throw new Error("seed failed: no ids");
	b.workOk(
		["block", blockedId, "--on", gatedId],
		"block the plain item on the gated one",
	);

	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${b.BASE}/#decisions`);

	// the gated card: id, owner-gated label, best-action line
	const gatedCard = page.locator(`#gatedList .gated[data-id="${gatedId}"]`);
	await expect(gatedCard).toBeVisible();
	await expect(gatedCard.locator(".dwho")).toContainText("owner-gated");
	await expect(gatedCard.locator(".dadv")).toContainText("owner-gated");

	// the blocked card names its blocker and the action names the dep
	const blockedCard = page.locator(`#gatedList .gated[data-id="${blockedId}"]`);
	await expect(blockedCard).toBeVisible();
	await expect(blockedCard.locator(".dwho")).toContainText("blocked");
	await expect(blockedCard.locator(".dadv")).toContainText(
		`blocked on ${gatedId}`,
	);

	// the payload is the report's own row set: /api/decisions .gated ids
	// equal the seeded pair (one source, CLI and board cannot disagree)
	const dec = await page.evaluate(async () => {
		const r = await fetch("/api/decisions");
		return (await r.json()) as { gated?: { id: string }[] };
	});
	const ids = (dec.gated ?? []).map((g) => g.id);
	expect(ids).toContain(gatedId);
	expect(ids).toContain(blockedId);
	expect(errors, "uncaught page exceptions").toEqual([]);
});
