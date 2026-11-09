// e2e/board-report-lit.e2e.ts — W2550.3: the report tab as a Lit feature
// (klh-report leaf + klh-report-mediator) in a REAL browser. Pins the
// contracts the retired REPORT chunk owned: THE work-report table renders
// (the CLI renderer's bytes in the <pre>), the stamp names the face and
// freshness, one expand chip per row, the expand/collapse toggle swaps the
// lane detail (head + honest no-transcript note), and a mid-look graph
// mutation lands within the poll cycle. Serial accumulation: rows minted
// by earlier tests in THIS board may also appear — pin the minted ids,
// never exact counts. pageWatcher asserts no uncaught exceptions.
import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

let w1 = "";
let w2 = "";

test.beforeAll(async ({ board }) => {
	// mint two items, claim one — the table must show ◐ + · rows
	w1 = board.mintedId(
		board.workOk(["add", "alpha rider for the report lit pane"], "mint alpha"),
	);
	w2 = board.mintedId(
		board.workOk(["add", "beta queued for the report lit pane"], "mint beta"),
	);
	board.workOk(["take", w1, "--as", "autow25503-e2e-lane"], "claim alpha");
});

test("report pane renders THE work-report table through the Lit leaf", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/#report`);
	await expect(page.locator("#tab-report")).toBeVisible();
	// THE renderer's header lands verbatim in the <pre> (W1198)
	const table = page.locator("#reportTable");
	await expect(table).toContainText("ITEM");
	await expect(table).toContainText(w1);
	await expect(table).toContainText(w2);
	// the tab's stamp names the face and its freshness
	await expect(page.locator("#reportStamp")).toContainText("the work report");
	// one expand chip per minted row (serial board: ≥ these two)
	const chips = page.locator("#reportRows .rptrow");
	await expect(chips.filter({ hasText: w1 })).toHaveCount(1);
	await expect(chips.filter({ hasText: w2 })).toHaveCount(1);
	// transport shape: the board face of the ONE renderer
	const j = (await (await fetch(`${board.BASE}/api/report`)).json()) as {
		ok: boolean;
		table: string;
		rows: { id: string; st: string }[];
	};
	expect(j.ok).toBe(true);
	expect(j.table).toContain("ITEM");
	expect(j.rows.map((r) => `${r.id} ${r.st}`)).toContain(`${w1} ◐`);
	expect(j.rows.map((r) => `${r.id} ${r.st}`)).toContain(`${w2} ·`);
});

test("expanding a row loads its lane detail; toggling closes it", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/#report`);
	const chip = page.locator(`.rptrow[data-rid="${w1}"]`);
	await expect(chip).toBeVisible({ timeout: 15_000 });
	// the claimed row expands to state + lane sid; no transcript → honest note
	await chip.click();
	const detail = page.locator("#reportDetail");
	await expect(detail).toContainText(w1);
	await expect(detail).toContainText("lane autow25503-e2e-lane");
	await expect(detail).toContainText("no live lane transcript for this row");
	// the open chip carries the on class (the old chunk's highlight)
	await expect(chip).toHaveClass(/on/);
	// toggling the same chip closes it
	await chip.click();
	await expect(detail).toBeHidden(); // :empty display:none
	// expand the queued row: still honest about the absent lane
	await page.locator(`.rptrow[data-rid="${w2}"]`).click();
	await expect(detail).toContainText(w2);
});

test("a lane spawn lands in the open table within the poll cycle", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/#report`);
	await expect(page.locator("#reportTable")).toContainText("ITEM");
	// graph mutation while the pane is open — the mediator's 2s feed is the
	// reflection, no per-row fan-out (W663)
	const w3 = board.mintedId(
		board.workOk(["add", "gamma spawned mid-look lit"], "mint gamma"),
	);
	await expect(page.locator("#reportTable")).toContainText(w3, {
		timeout: 15_000,
	});
});
