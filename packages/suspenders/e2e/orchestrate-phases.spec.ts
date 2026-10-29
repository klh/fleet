// e2e/orchestrate-phases.spec.ts — W863: the orchestrate preview paints the
// pre-injection phase map. Scratch board + repo (harness.ts); prompt.log is
// flipped on via the settings API, the preview element is driven through its
// public prepare() seam, and the phases section must render six honest rows
// (planner ×3, lane-brief unknown, repo-law ready, remote-policy unsupported)
// plus the no-wire-bytes note.
import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBoard, type Board } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("orchestrate-phases");
	writeFileSync(join(board.MY_PROJ, "AGENTS.md"), "law: be terse\n");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("preview phases render as honest rows", async ({ page }) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#tasks`);
	// log mode on — phase content rides the log gate; the write needs the
	// board's own x-klh-write-token (W264 guard)
	const token = readFileSync(
		join(b.HOME, ".cache/claude-governor/write-token"),
		"utf8",
	).trim();
	// W1303.2: settings writes are conditional — If-Match the GET etag
	const cur = await (await fetch(`${b.BASE}/api/prompt/settings`)).json();
	const on = await fetch(`${b.BASE}/api/prompt/settings`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-klh-write-token": token,
			"if-match": cur.etag,
		},
		body: JSON.stringify({ "prompt.log": true }),
	});
	expect(on.ok, `${on.status} ${await on.clone().text()}`).toBe(true);
	// the orchestrate panel is a collapsed <details> on HEAD's board
	await page.locator("details:has(#orchPreview) > summary").click();
	const el = page.locator("klh-prompt-preview#orchPreview");
	await expect(el).toBeVisible();
	await el.evaluate(
		(node, { project, goal }) =>
			void (
				node as { prepare: (p: string, g: string) => Promise<void> }
			).prepare(project, goal),
		{ project: b.MY_PROJ, goal: "add csv export" },
	);
	// the six phases render with their metadata and honest states
	await expect(el).toContainText("pre-injection context phases");
	await expect(el).toContainText("goal header (prepended)");
	await expect(el).toContainText("ORCH_SYS constant");
	await expect(el).toContainText("cache yes");
	await expect(el).toContainText("cache no");
	await expect(el).toContainText("lane bootstrap brief");
	await expect(el).toContainText("materializes at dispatch");
	await expect(el).toContainText("size unknown");
	await expect(el).toContainText("repo law (AGENTS.md / CLAUDE.md)");
	await expect(el).toContainText("remote corporate policy");
	await expect(el).toContainText("Core SKU");
	await expect(el).toContainText("never claimed");
	// the disclosed content is real: repo law opens and shows the file
	const law = el.locator("details").filter({ hasText: "repo law" });
	await law.locator("summary").click();
	await expect(law.locator("pre")).toContainText("law: be terse");
});
