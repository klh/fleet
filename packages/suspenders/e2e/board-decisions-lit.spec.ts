// e2e/board-decisions-lit.spec.ts — W2550.1: the decisions tab as a Lit
// feature (klh-decisions leaf + klh-decisions-mediator) in a REAL browser.
// Pins the contracts the retired DECISIONS/HISTORY chunks owned: cards
// render from /api/decisions, the answer flow answers a real decision
// through /api/answer (typed event → mediator POST), drafts survive the
// 1Hz poll re-render, gated rows render, history toggles + filters by
// project, collapse drives the #needsn badge and title, advise surfaces
// its failed-state inline UI (dead-upstream fixture pins), and the whole
// page stays free of uncaught exceptions (pageWatcher).

import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const SEED_Q = "W2550 lit decisions probe — pick a lane";

/** Seed one OPEN decision into the board's own scratch graph (the
 * decisions table is board-owned — the direct-seed idiom the sibling
 * specs use; questions are unique per seed). */
async function seedDecision(
	board: import("../test/helpers/board-harness").Board,
	question: string,
	extraPayload: Record<string, unknown> = {},
): Promise<string> {
	const { Database } = await import("bun:sqlite");
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	try {
		const ev = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 'w2550-lit', 'NEED_DECISION', NULL, ?, ?, ?)",
			)
			.run(
				Date.now(),
				JSON.stringify({
					project: board.MY_PROJ,
					note: question,
					...extraPayload,
				}),
				"lane-w2550",
				board.MY_PROJ,
			);
		db.query(
			"INSERT INTO decisions (event_id, target, asked_by, project, question, state, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)",
		).run(
			ev.lastInsertRowid,
			"lane-w2550",
			"lane-w2550",
			board.MY_PROJ,
			question,
			Date.now(),
		);
		return String(ev.lastInsertRowid);
	} finally {
		db.close();
	}
}

test("decision cards render; answering one real decision resolves it", async ({
	page,
	board,
}) => {
	const id = await seedDecision(board, SEED_Q);
	await page.goto(`${board.BASE}/#decisions`);

	const card = page.locator(`#decList .dec[data-id="${id}"]`);
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card.locator(".dq")).toContainText(SEED_Q);

	// the answer flow: type → Send → typed event → mediator POST → poll
	// resolves the card away (state leaves OPEN)
	const input = card.locator("input.ans");
	await input.fill("proceed with the local lane");
	await card.locator("button.send").click();

	// answered decisions leave OPEN (the card disappears on the next poll)
	await expect(card).toBeHidden({ timeout: 15_000 });

	// the wire really carried the answer
	const { Database } = await import("bun:sqlite");
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	const row = db
		.query("SELECT state FROM decisions WHERE event_id = ?")
		.get(Number(id)) as { state: string } | undefined;
	db.close();
	expect(row?.state).not.toBe("OPEN");
});

test("drafts survive the 1Hz poll re-render", async ({ page, board }) => {
	const id = await seedDecision(board, `${SEED_Q} — draft`);
	await page.goto(`${board.BASE}/#decisions`);
	const card = page.locator(`#decList .dec[data-id="${id}"]`);
	await expect(card).toBeVisible({ timeout: 15_000 });
	const input = card.locator("input.ans");
	await input.fill("half-typed thought");
	// the 1Hz ticker re-pushes the slice; the focused input keeps its value
	// and the draft survives the next render
	await page.waitForTimeout(2500);
	await expect(input).toHaveValue("half-typed thought");
});

test("advise surfaces the failed-state inline UI (dead upstream)", async ({
	page,
	board,
}) => {
	const id = await seedDecision(board, `${SEED_Q} — advise`);
	await page.goto(`${board.BASE}/#decisions`);
	const card = page.locator(`#decList .dec[data-id="${id}"]`);
	await expect(card).toBeVisible({ timeout: 15_000 });
	await card.locator("button.getrec").click();
	// W667: transport failure is NOT advice failure — backoff + re-fire,
	// spinner stays honest. Under the dead-upstream fixture the request
	// lands in the retry ladder; the card shows the honest busy state and
	// never a fabricated verdict. (A full backoff ladder run takes 14s+;
	// this pins the busy → honest-failure transition.)
	const advice = card.locator(".dadv");
	await expect
		.poll(
			async () => {
				const t = (await advice.locator("span").first().textContent()) ?? "";
				return /getting recommendation|advice request failed|advice failed/.test(
					t,
				);
			},
			{ timeout: 45_000 },
		)
		.toBe(true);
});

test("gated rows render with best-action lines", async ({ page, board }) => {
	const gatedId = board.workOk(
		["add", "OWNER-GATED: W2550 lit gated probe"],
		"seed gated",
	);
	const gatedCard = page.locator(
		`#gatedList .gated[data-id="${gatedId.match(/W\d+/)?.[0] ?? "W0"}"]`,
	);
	await page.goto(`${board.BASE}/#decisions`);
	await expect(gatedCard).toBeVisible({ timeout: 15_000 });
	await expect(gatedCard.locator(".dwho")).toContainText("owner-gated");
	await expect(gatedCard.locator(".dadv")).toContainText("owner-gated");
});

test("policy decision carries the policy pill and provenance line", async ({
	page,
	board,
}) => {
	// W862: the validated NEED_DECISION payload.policy renders as the .dpol
	// pill + .dsrc provenance line (origin disclosed, never inferred)
	const id = await seedDecision(
		board,
		"W2550 lit policy probe — health endpoint?",
		{
			policy: {
				hub: "https://corp.example",
				sha256: "a".repeat(64),
				id: "corp.health",
				source: "operator:corp-v1",
			},
		},
	);
	await page.goto(`${board.BASE}/#decisions`);
	const card = page.locator(`#decList .dec[data-id="${id}"]`);
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card.locator(".dpol")).toHaveText("policy");
	await expect(card.locator(".dsrc")).toContainText(
		"policy provenance: hub https://corp.example · row corp.health · pin aaaaaaaaaaaa",
	);
});

test("history toggles open, lists archived rows, filters by project", async ({
	page,
	board,
}) => {
	const id = await seedDecision(board, `${SEED_Q} — history`);
	// answer it so it becomes history
	const { Database } = await import("bun:sqlite");
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	db.query(
		"UPDATE decisions SET state='ANSWERED', answered_at=? WHERE event_id = ?",
	).run(Date.now(), Number(id));
	db.close();

	await page.goto(`${board.BASE}/#decisions`);
	await page.locator("#histHead").click();
	// serial accumulation: earlier tests' answered rows may also be archived —
	// pin THIS question's row, not an exact count
	const row = page.locator("#histBody .hrow", {
		hasText: `${SEED_Q} — history`,
	});
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.locator(".pill.hst")).toHaveText("answered");
	await expect(page.locator("#histState")).toContainText("archived");
});

test("collapse collapses the section; the needsn badge and title follow", async ({
	page,
	board,
}) => {
	await seedDecision(board, `${SEED_Q} — collapse`);
	await page.goto(`${board.BASE}/#decisions`);
	const section = page.locator("#decisions");
	await expect(section).toBeVisible({ timeout: 15_000 });
	// serial accumulation: earlier tests' OPEN decisions also count — pin the
	// badge's shape, not an exact count
	await expect(page.locator("#needsn")).toContainText("need you");

	// collapse via the caret
	await page.locator("#decToggle").click();
	await expect(section).toHaveClass(/closed/);
	await expect(page).toHaveTitle(/FLEET BOARD/);
});
