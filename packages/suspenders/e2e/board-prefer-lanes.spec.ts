// e2e/board-prefer-lanes.spec.ts — W812: the lanes kanban paints the .prefer
// color as a per-card border for a lane whose tree .prefer carries a color.
// Scratch board + scratch repo (harness.ts); .prefer at the repo root covers
// the project; a minted READY card must render with the --prefer token and a
// computed border of that exact color; an untagged card stays on the default.
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

const COLOR = "#0058A3";
// #0058A3 = rgb(0, 88, 163)
const COLOR_RGB = "rgb(0, 88, 163)";

let board: Board | null = null;
let taggedId = "";

test.beforeAll(async () => {
	board = await startBoard("board-prefer-lanes");
	// tree identity: the scratch repo's own .prefer carries the color
	writeFileSync(
		join(board.MY_PROJ, ".prefer"),
		`tag = "ikea"\ncolor = "${COLOR}"\n`,
	);
	taggedId = board.mintedId(
		board.workOk(["add", "prefer-colored lane card"], "mint tagged item"),
	);
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("tagged card paints the .prefer border on #lanes", { tag: "@ui" }, async ({
	page,
}) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#lanes`);
	const card = page
		.locator(".kcard")
		.filter({ has: page.locator(`[data-task="${taggedId}"]`) });
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute("style", `--prefer:${COLOR}`);
	await expect
		.poll(async () =>
			card.evaluate((el) => getComputedStyle(el).borderTopColor),
		)
		.toBe(COLOR_RGB);
	// hover keeps the token (hover rule re-resolves --prefer)
	await card.hover();
	await expect
		.poll(async () =>
			card.evaluate((el) => getComputedStyle(el).borderTopColor),
		)
		.toBe(COLOR_RGB);
});

// the absent-prefer path (no token, default edge) is covered by the
// board-prefer.test.ts chunk sandbox — every card in this harness shares
// the one tagged repo, so no untagged card exists hermetically.
