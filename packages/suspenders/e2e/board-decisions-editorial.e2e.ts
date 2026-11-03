// e2e/board-decisions-editorial.e2e.ts — W2267.8: the decisions surface
// under the editorial card language (decisions.scss through design-ui's
// compileStylesheet). Pins the contract the redesign must keep: option
// selection changes the DRAFT only (no POST until the explicit rail Send —
// selection is never submission), drafts + focus + selection + expanded
// history survive a payload refresh (the leaf's render guard), keyboard
// operation (Tab to the rail, Enter submits), the honest error states
// (feed banner, empty send), duplicate grouping (+N badge, class POST
// ids[]), policy provenance, gated rows, and the full-bleed action rail
// geometry — .drail's left and right edges sit exactly on the card's
// border box at desktop AND narrow widths. Light/dark screenshots (full
// page + focused card + rail) land in /tmp/w2267-shots. NEVER submits a
// real user decision: every Send answers a scratch-world fork through the
// same API a human would.

import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { expect, test } from "./fixtures";
import type { Board } from "../test/helpers/board-harness";

const SHOTS = "/tmp/w2267-shots";
mkdirSync(SHOTS, { recursive: true });

test.describe.configure({ mode: "serial" });

/** Rail-edge vs card-edge offsets + page overflow, measured in one pass. */
type Geometry = {
	railLeft: number;
	railRight: number;
	railBottom: number;
	cardLeft: number;
	cardRight: number;
	cardBottom: number;
	scrollW: number;
	clientW: number;
};

/** Seed one OPEN decision into the board's own scratch graph (the
 * direct-seed idiom board-decisions-lit.spec.ts uses; questions unique
 * per seed). Extra payload keys ride the event row (options, policy...). */
async function seedDecision(
	board: Board,
	question: string,
	extraPayload: Record<string, unknown> = {},
): Promise<string> {
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	try {
		const ev = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target, project) VALUES (?, 'w2267-editorial', 'NEED_DECISION', NULL, ?, ?, ?)",
			)
			.run(
				Date.now(),
				JSON.stringify({
					project: board.MY_PROJ,
					note: question,
					...extraPayload,
				}),
				"lane-w2267",
				board.MY_PROJ,
			);
		db.query(
			"INSERT INTO decisions (event_id, target, asked_by, project, question, state, created_at, options) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)",
		).run(
			ev.lastInsertRowid,
			"lane-w2267",
			"lane-w2267",
			board.MY_PROJ,
			question,
			Date.now(),
			extraPayload.options ? JSON.stringify(extraPayload.options) : null,
		);
		return String(ev.lastInsertRowid);
	} finally {
		db.close();
	}
}

/** A stored recommendation the feed renders as the .dadv success block
 * (fact advice.<id> — the W667 advice view; rec must pass usableRec). */
function seedAdvice(board: Board, id: string, rec: string): void {
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	try {
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'w2267-fixture', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(`advice.${id}`, JSON.stringify({ rec }), Date.now());
	} finally {
		db.close();
	}
}

/** Stored advice error → the card's inline "advice failed" + retry row. */
function seedAdviceError(board: Board, id: string, msg: string): void {
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	try {
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'w2267-fixture', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(`advice.${id}.error`, msg, Date.now());
	} finally {
		db.close();
	}
}

/** The geometry proof: rail edges vs card edges + page overflow probe. */
async function railGeometry(
	card: import("@playwright/test").Locator,
): Promise<Geometry> {
	return card.locator(".drail").evaluate(
		(rail, host) => {
			const r = rail.getBoundingClientRect();
			const c = (host as Element).getBoundingClientRect();
			return {
				railLeft: r.left,
				railRight: r.right,
				railBottom: r.bottom,
				cardLeft: c.left,
				cardRight: c.right,
				cardBottom: c.bottom,
				scrollW: document.documentElement.scrollWidth,
				clientW: document.documentElement.clientWidth,
			};
		},
		await card.elementHandle(),
	);
}

/** Force a real dec-feed fetch through the page's FeedStore (boardFeeds()
 * is the module singleton the mediator subscribes). */
async function kickDec(page: import("@playwright/test").Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as {
			boardFeeds?: { kick: (n: string, f?: boolean) => void };
		};
		if (w.boardFeeds) w.boardFeeds().kick("dec", true);
	});
}

/** The visual record: full page + focused card + rail, per theme × width. */
async function shoot(
	page: import("@playwright/test").Page,
	card: import("@playwright/test").Locator,
	theme: string,
	width: string,
): Promise<void> {
	await page.screenshot({
		path: `${SHOTS}/decisions-${theme}-${width}.png`,
		fullPage: true,
	});
	await card.screenshot({ path: `${SHOTS}/card-${theme}-${width}.png` });
	await card.locator(".drail").screenshot({
		path: `${SHOTS}/rail-${theme}-${width}.png`,
	});
}

// The honest-banner test fulfills /api/decisions with a malformed body
// through page.route on purpose — the feed's accept() throws, the banner
// renders, and no browser resource-load noise fires (200 on the wire).
test.describe("W2267.8 editorial decisions @ui", () => {
	test("option selection changes the draft only — Send is the only submission", async ({
		page,
		board,
	}) => {
		const id = await seedDecision(board, "W2267 editorial — pick lane", {
			options: [
				{ label: "Ship now", tradeoff: "fast, riskier" },
				{ label: "Hold one day", tradeoff: "safer, slower" },
			],
		});
		let answers = 0;
		page.on("request", (r) => {
			if (r.url().includes("/api/answer")) answers++;
		});
		await page.goto(`${board.BASE}/#decisions`);
		const card = page.locator(`#decList .dec[data-id="${id}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".optrow .trade").first()).toContainText(
			"fast, riskier",
		);
		// selecting sets aria-pressed + copies the label into the draft —
		// but the wire stays silent (selection is never submission)
		await card.locator('button.opt:has-text("Hold one day")').click();
		await expect(card.locator(".optrow.sel button.opt")).toHaveText(
			"Hold one day",
		);
		await expect(card.locator("input.ans")).toHaveValue("Hold one day");
		expect(answers, "selection must not POST").toBe(0);
		// the explicit rail Send submits; the decision resolves
		await card.locator(".drail button.send").click();
		await expect(card).toBeHidden({ timeout: 15_000 });
		expect(answers).toBe(1);
	});
	test("dup-grouped decision shows +N badge; rail Send resolves the class", async ({
		page,
		board,
	}) => {
		// W798 anchor: a shared path-like token groups same-project forks
		const q = "W2267 editorial dup class — blocked on /repo/dep/path?";
		const a = await seedDecision(board, q);
		const b = await seedDecision(board, q);
		await page.goto(`${board.BASE}/#decisions`);
		const primary = Number(b) > Number(a) ? b : a;
		const member = primary === a ? b : a;
		const card = page.locator(`#decList .dec[data-id="${primary}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".ddup")).toHaveText("+1 like this");
		await expect(
			page.locator(`#decList .dec[data-id="${member}"]`),
		).toBeHidden();
		await card.locator("input.ans").fill("class ruling: proceed");
		await card.locator(".drail button.send").click();
		await expect(card).toBeHidden({ timeout: 15_000 });
		// the whole class left OPEN, not just the primary
		const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		const rows = db
			.query("SELECT event_id, state FROM decisions WHERE event_id IN (?, ?)")
			.all(Number(a), Number(b)) as { event_id: number; state: string }[];
		db.close();
		expect(rows.every((r) => r.state !== "OPEN")).toBe(true);
	});

	test("draft, focus, selection, and expanded history survive a payload refresh", async ({
		page,
		board,
	}) => {
		const id = await seedDecision(
			board,
			"W2267 editorial — retention across refresh",
			{ options: [{ label: "Option A", tradeoff: "first" }] },
		);
		await page.goto(`${board.BASE}/#decisions`);
		const card = page.locator(`#decList .dec[data-id="${id}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await page.locator("#histHead").click();
		await expect(page.locator("#histBody .hrow").first()).toBeVisible();
		await card.locator("button.opt").first().click();
		await card.locator("input.ans").fill("kept mid-thought");
		await card.locator("input.ans").focus();
		// force a real payload fetch (the store re-parses and re-renders)
		await kickDec(page);
		await page.waitForTimeout(600);
		await expect(card.locator("input.ans")).toHaveValue("kept mid-thought");
		await expect(card.locator(".optrow.sel")).toHaveCount(1);
		const focused = await card
			.locator("input.ans")
			.evaluate((el) => document.activeElement === el);
		expect(focused).toBe(true);
		await expect(page.locator("#histBody .hrow").first()).toBeVisible();
	});

	test("keyboard: Tab reaches the rail; Enter in the input submits", async ({
		page,
		board,
	}) => {
		const id = await seedDecision(board, "W2267 editorial — keyboard drive");
		await page.goto(`${board.BASE}/#decisions`);
		const card = page.locator(`#decList .dec[data-id="${id}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		const input = card.locator("input.ans");
		await input.fill("keyboard answer");
		// Enter in the answer input submits (the leaf's keydown handler)
		await input.press("Enter");
		await expect(card).toBeHidden({ timeout: 15_000 });
		// a second card proves the rail itself is keyboard-operable
		const id2 = await seedDecision(board, "W2267 editorial — rail by tab");
		await page.goto(`${board.BASE}/#decisions`);
		const card2 = page.locator(`#decList .dec[data-id="${id2}"]`);
		await expect(card2).toBeVisible({ timeout: 15_000 });
		await card2.locator("input.ans").fill("tab answer");
		// tab forward into the rail — the eval affordance in .dbody sits
		// between input and rail, and keyboard.press walks the REAL focus
		// chain (locator.press would re-focus the input every iteration)
		await card2.locator("input.ans").focus();
		let onSend = false;
		for (let i = 0; i < 5 && !onSend; i++) {
			await page.keyboard.press("Tab");
			onSend = await card2
				.locator(".drail button.send")
				.evaluate((el) => document.activeElement === el);
		}
		expect(onSend).toBe(true);
		await card2.locator(".drail button.send").press("Enter");
		await expect(card2).toBeHidden({ timeout: 15_000 });
	});

	test("empty send is refused inline; feed failure shows the honest banner", async ({
		page,
		board,
	}) => {
		const id = await seedDecision(board, "W2267 editorial — honest states");
		await page.goto(`${board.BASE}/#decisions`);
		const card = page.locator(`#decList .dec[data-id="${id}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		// empty send: inline refusal, no POST
		let answers = 0;
		page.on("request", (r) => {
			if (r.url().includes("/api/answer")) answers++;
		});
		await card.locator(".drail button.send").click();
		await expect(card.locator(".derr")).toHaveText("type an answer first");
		expect(answers).toBe(0);
		// feed failure: the banner shows, the last good cards stay. A 200
		// with a malformed body fails the feed's accept() — the honest
		// product path, without browser resource-load noise.
		await page.route("**/api/decisions**", (route) => {
			void route.fulfill({
				status: 200,
				contentType: "application/json",
				body: "not a decisions payload",
			});
		});
		await kickDec(page);
		await expect(page.locator("#decErr")).toContainText(
			"decision feed unavailable",
		);
		await expect(card).toBeVisible();
		await page.unroute("**/api/decisions**");
	});

	test("advice success renders the .dadv block; stored failure shows retry", async ({
		page,
		board,
	}) => {
		const okId = await seedDecision(board, "W2267 editorial — advice success");
		seedAdvice(board, okId, "Proceed with the staged rollout tomorrow.");
		const errId = await seedDecision(board, "W2267 editorial — advice failure");
		seedAdviceError(board, errId, "oracle leg refused");
		await page.goto(`${board.BASE}/#decisions`);
		const ok = page.locator(`#decList .dec[data-id="${okId}"]`);
		await expect(ok).toBeVisible({ timeout: 15_000 });
		await expect(ok.locator(".dadv .rec")).toContainText(
			"Proceed with the staged rollout tomorrow.",
		);
		await ok.locator(".dadv button.use").click();
		await expect(ok.locator("input.ans")).toHaveValue(
			"Proceed with the staged rollout tomorrow.",
		);
		const bad = page.locator(`#decList .dec[data-id="${errId}"]`);
		await expect(bad).toBeVisible();
		await expect(bad.locator(".dadv .risk")).toContainText(
			"advice failed: oracle leg refused",
		);
		await expect(bad.locator(".dadv button.advretry")).toBeVisible();
	});

	test("gated rows and policy provenance render compact", async ({
		page,
		board,
	}) => {
		const gatedId = board.mintedId(
			board.workOk(["add", "OWNER-GATED: W2267 editorial gated probe"], "seed"),
		);
		const polId = await seedDecision(
			board,
			"W2267 editorial — policy provenance row?",
			{
				policy: {
					hub: "https://corp.example",
					sha256: "b".repeat(64),
					id: "corp.health",
					source: "operator:corp-v1",
				},
			},
		);
		await page.goto(`${board.BASE}/#decisions`);
		const gated = page.locator(`#gatedList .gated[data-id="${gatedId}"]`);
		await expect(gated).toBeVisible({ timeout: 15_000 });
		await expect(gated.locator(".dwho")).toContainText("owner-gated");
		const pol = page.locator(`#decList .dec[data-id="${polId}"]`);
		await expect(pol).toBeVisible();
		await expect(pol.locator(".dpol")).toHaveText("policy");
		await expect(pol.locator(".dsrc")).toContainText(
			"policy provenance: hub https://corp.example · row corp.health · pin bbbbbbbbbbbb",
		);
	});

	test("rail flush with card edges at desktop + narrow; long text never overflows", async ({
		page,
		board,
	}) => {
		const id = await seedDecision(board, "W2267 editorial — rail geometry");
		await page.goto(`${board.BASE}/#decisions`);
		const card = page.locator(`#decList .dec[data-id="${id}"]`);
		await expect(card).toBeVisible({ timeout: 15_000 });
		const flush = (g: Geometry, where: string): void => {
			expect(g.railLeft, `rail left edge (${where})`).toBeCloseTo(
				g.cardLeft,
				0,
			);
			expect(g.railRight, `rail right edge (${where})`).toBeCloseTo(
				g.cardRight,
				0,
			);
			// the rail IS the card's bottom edge — nothing (the eval
			// affordance, a stray widget) may sit below it (#103109)
			expect(g.railBottom, `rail bottom edge (${where})`).toBeCloseTo(
				g.cardBottom,
				0,
			);
			expect(g.scrollW, `page overflow (${where})`).toBeLessThanOrEqual(
				g.clientW,
			);
		};
		flush(await railGeometry(card), "desktop");
		await page.setViewportSize({ width: 420, height: 800 });
		await page.waitForTimeout(300);
		flush(await railGeometry(card), "narrow");
	});

	test("screenshots: light + dark, full page + card + rail, desktop + narrow", async ({
		page,
		board,
	}) => {
		// one rich card: options + tradeoffs + a stored recommendation
		const id = await seedDecision(board, "W2267 editorial — visual record", {
			options: [
				{ label: "Ship now", tradeoff: "fast, riskier" },
				{ label: "Hold one day", tradeoff: "safer, slower" },
			],
		});
		seedAdvice(board, id, "Proceed with the staged rollout tomorrow.");
		for (const theme of ["dark", "light"] as const) {
			await page.addInitScript(
				(t) => localStorage.setItem("klh-theme", t),
				theme,
			);
			await page.goto(`${board.BASE}/#decisions`);
			const card = page.locator(`#decList .dec[data-id="${id}"]`);
			await expect(card).toBeVisible({ timeout: 15_000 });
			await expect(card.locator(".dadv .rec")).toContainText(
				"Proceed with the staged rollout tomorrow.",
			);
			await shoot(page, card, theme, "desktop");
			await page.setViewportSize({ width: 420, height: 800 });
			await page.waitForTimeout(300);
			await shoot(page, card, theme, "narrow");
			await page.setViewportSize({ width: 1440, height: 900 });
		}
	});
});
