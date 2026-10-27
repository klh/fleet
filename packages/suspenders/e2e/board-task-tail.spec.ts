// e2e/board-task-tail.spec.ts — W1270: the W1190 task-tail dispatch binding
// proves out in the browser. A task row shows a transcript tail ONLY for the
// exact dispatch binding (project + item + owner sid, assistant text written
// after the attempt's launch): a same-owner sibling without a registry row
// stays empty, and a session re-pinned to another project loses its tail even
// while the lane-registry row still matches. Real board + scratch HOME
// (harness.ts); the binding rides the real governor.db sessions row and the
// scratch repo's .fleet/lanes.json — the exact production surfaces.

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let bound = "";
let sibling = "";
let crossed = "";
let project = "";

const assistant = (text: string, ts: number): string =>
	JSON.stringify({
		timestamp: new Date(ts).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	});

test.beforeAll(async () => {
	board = await startBoard("task-tail");
	const b = board;
	bound = b.mintedId(b.workOk(["add", "w1270 tail bound item"], "add"));
	sibling = b.mintedId(b.workOk(["add", "w1270 tail sibling item"], "add"));
	crossed = b.mintedId(b.workOk(["add", "w1270 tail cross item"], "add"));
	const laneA = "autow1270-bound";
	const laneB = "autow1270-crossed";
	b.workOk(["take", bound, "--as", laneA], "take");
	b.workOk(["take", sibling, "--as", laneA], "take");
	b.workOk(["take", crossed, "--as", laneB], "take");
	// the project string the graph actually recorded for these items — the
	// sessions rows and the registry must use the exact same spelling
	const feed = (await (await fetch(`${b.BASE}/api/tasks?done=all`)).json()) as {
		tasks: { project: string }[];
	};
	project = feed.tasks[0]?.project ?? "";
	expect(project, "no project on the seeded tasks feed").not.toBe("");
	// the registry binds both lanes to their attempts; the transcript holds
	// one pre-launch record (skipped by the launchedAt floor) and one current
	const now = Date.now();
	// W1294.2: lanes.json is read from the checkout ROOT (projectRootOf strips
	// the graph key's /.git tail) — never inside the common dir itself
	mkdirSync(join(b.MY_PROJ, ".fleet"), { recursive: true });
	writeFileSync(
		join(b.MY_PROJ, ".fleet", "lanes.json"),
		JSON.stringify([
			{ sid: laneA, item: bound, launchedAt: now - 60_000 },
			{ sid: laneB, item: crossed, launchedAt: now - 60_000 },
		]),
	);
	const transcript = join(b.HOME, "fixture-transcript.jsonl");
	writeFileSync(
		transcript,
		`${assistant("stale pre-launch progress", now - 120_000)}\n`,
	);
	const db = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	for (const sid of [laneA, laneB])
		db.query(
			"INSERT INTO sessions(sid,project,role,started_at,hb,transcript_path) VALUES (?,?,'worker',?,?,?)",
		).run(sid, project, now, now, transcript);
	db.close();
	// the current assistant text lands after both registry launches
	appendFileSync(
		transcript,
		`${assistant("bound lane reading the diff", now)}\n`,
	);
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("exact binding shows the transcript tail; the unbound sibling stays empty", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#tasks`);
	const boundRow = page.locator(`tr[data-tid="${bound}"]`);
	await expect(boundRow).toBeVisible();
	await page.locator("#taskDetails").click();
	await expect(boundRow.locator(".tail")).toHaveText(
		"bound lane reading the diff",
	);
	// same owner sid, no registry row for this item: no tail node at all
	const siblingRow = page.locator(`tr[data-tid="${sibling}"]`);
	await expect(siblingRow).toBeVisible();
	await expect(siblingRow.locator(".tail")).toHaveCount(0);
	// the stale pre-launch record never surfaces on the bound row either
	await expect(boundRow.locator(".tail")).not.toContainText(
		"stale pre-launch progress",
	);
});

test("kanban card carries the bound tail on the lanes view", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#lanes`);
	const card = page.locator(`.kcard[data-kid="${bound}"]`);
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card.locator(".ktail")).toHaveText(
		"bound lane reading the diff",
	);
	await expect(
		page.locator(`.kcard[data-kid="${sibling}"] .ktail`),
	).toHaveCount(0);
});

test("a registry match cannot cross a session's project partition", {
	tag: "@ui",
}, async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#tasks`);
	const crossedRow = page.locator(`tr[data-tid="${crossed}"]`);
	await expect(crossedRow).toBeVisible();
	await page.locator("#taskDetails").click();
	// same-project binding still works for the second lane before the move
	await expect(crossedRow.locator(".tail")).toHaveText(
		"bound lane reading the diff",
	);
	// re-pin ONLY the crossed lane's session to another project: its tail
	// dies while the bound lane keeps rendering (per-session, not feed-wide)
	const db = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	db.query("UPDATE sessions SET project = 'other-project' WHERE sid = ?").run(
		"autow1270-crossed",
	);
	db.close();
	await page.reload();
	await expect(crossedRow).toBeVisible();
	await page.locator("#taskDetails").click();
	await expect(crossedRow.locator(".tail")).toHaveCount(0);
	await expect(page.locator(`tr[data-tid="${bound}"] .tail`)).toHaveText(
		"bound lane reading the diff",
	);
});
