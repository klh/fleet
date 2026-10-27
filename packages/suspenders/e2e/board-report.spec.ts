// e2e/board-report.spec.ts — W1198: the Report tab renders THE work-report
// table (the CLI renderer's bytes) fed live from the graph, with per-row
// expand to the lane transcript tail + last-event stamp. Runs a REAL board
// (scratch HOME + repo) against a REAL work graph minted via the work CLI —
// no mocks on the transport or the renderer.
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let w1 = "";
let w2 = "";

test.beforeAll(async () => {
	board = await startBoard("board-report");
	// mint two items, claim one — the table must show R + Q rows
	w1 = board.mintedId(
		board.workOk(["add", "alpha rider for the report pane"], "mint alpha"),
	);
	w2 = board.mintedId(
		board.workOk(["add", "beta queued for the report pane"], "mint beta"),
	);
	board.workOk(["take", w1, "--as", "autow1198-e2e-lane"], "claim alpha");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("report pane renders THE work-report table with expandable rows", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/#report`);
	await expect(page.locator("#tab-report")).toBeVisible();
	// THE renderer's header lands verbatim in the <pre>
	const table = page.locator("#reportTable");
	await expect(table).toContainText("ITEM");
	await expect(table).toContainText(w1);
	await expect(table).toContainText(w2);
	// the tab's stamp names the face and its freshness
	await expect(page.locator("#reportStamp")).toContainText("the work report");
	// one expand chip per row
	const chips = page.locator("#reportRows .rptrow");
	await expect(chips).toHaveCount(2);
	// transport shape: the board face of the ONE renderer
	const j = (await (await fetch(`${mustBoard().BASE}/api/report`)).json()) as {
		ok: boolean;
		table: string;
		rows: { id: string; st: string }[];
	};
	expect(j.ok).toBe(true);
	expect(j.table).toContain("ITEM");
	expect(j.rows.map((r) => `${r.id} ${r.st}`).sort()).toEqual(
		[`${w1} ◐`, `${w2} ·`].sort(), // W1131 §3 board glyphs: working · ready
	);
	expect(errors, "uncaught page exceptions").toEqual([]);
});

test("expanding a row loads its lane detail", async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/#report`);
	const chips = page.locator("#reportRows .rptrow");
	await expect(chips).toHaveCount(2);
	// the claimed row expands to state + lane sid; no transcript → honest note
	await page.locator(`.rptrow[data-rid="${w1}"]`).click();
	const detail = page.locator("#reportDetail");
	await expect(detail).toContainText(w1);
	await expect(detail).toContainText("lane autow1198-e2e-lane");
	await expect(detail).toContainText("no live lane transcript for this row");
	// toggling the same chip closes it
	await page.locator(`.rptrow[data-rid="${w1}"]`).click();
	await expect(detail).toBeHidden(); // :empty display:none
	// expand the queued row: still honest about the absent lane
	await page.locator(`.rptrow[data-rid="${w2}"]`).click();
	await expect(detail).toContainText(w2);
});

test("a lane spawn lands in the open table within the poll cycle", async ({
	page,
}) => {
	await page.goto(`${mustBoard().BASE}/#report`);
	await expect(page.locator("#reportTable")).toContainText("ITEM");
	// graph mutation while the pane is open — the shared poll (1s) over the
	// 3s memo is the "one event push" reflection, no per-row fan-out (W663)
	const w3 = mustBoard().mintedId(
		mustBoard().workOk(["add", "gamma spawned mid-look"], "mint gamma"),
	);
	await expect(page.locator("#reportTable")).toContainText(w3, {
		timeout: 15_000,
	});
});
