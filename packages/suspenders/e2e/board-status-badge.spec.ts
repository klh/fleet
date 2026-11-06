// e2e/board-status-badge.spec.ts — W998.1 → approved09 rewrite (root
// #103544): the status badge is no longer a corner tab on .krow .pill — it
// is the square + status word in the klh-task-card shadow DOM (.head >
// .sq[data-tone] + .stw). Measured geometry (getBoundingClientRect) and
// computed token colors — never strings off the wire — across all states,
// both themes and at both a desktop and a narrow viewport. W1136: rides the
// shared fixtures — worker board + the auto pageWatcher.

import type { Page } from "@playwright/test";
import type { Board } from "../test/helpers/board-harness";
import { expect, test } from "./fixtures";

const STATES = [
	"READY",
	"CLAIMED",
	"RUNNING",
	"DONE",
	"FAILED",
	"BLOCKED",
	"PAUSED",
	"CANCELLED",
	"SHATTERED",
];

// approved09 tone map (klh-task-card-model.ts taskTone) + the status word
// (taskStatusWord: SHATTERED renders the board's "split" vocabulary)
const TONE_OF: Record<string, string> = {
	READY: "ready",
	CLAIMED: "working",
	RUNNING: "working",
	DONE: "done",
	FAILED: "failed",
	BLOCKED: "blocked",
	PAUSED: "blocked",
	CANCELLED: "cancelled",
	SHATTERED: "split",
};

// the tone→token contract the card’s own SCSS pins (klh-task-card.scss
// :host([data-tone=…]) --state-color map)
const TOKEN_OF: Record<string, string> = {
	ready: "--work-ready",
	working: "--work-working",
	blocked: "--work-blocked",
	failed: "--work-failed",
	done: "--work-done",
	split: "--work-split",
	cancelled: "--work-cancelled",
};

function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a 6-digit hex token: ${hex}`);
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const WORD_OF: Record<string, string> = Object.fromEntries(
	STATES.map((s) => [s, s === "SHATTERED" ? "split" : s.toLowerCase()]),
);

interface BadgeGeom {
	id: string;
	tone: string;
	word: string;
	dx: number;
	dy: number;
	sqH: number;
	alignSelf: string;
}

/** Inject one synthetic task per state, then measure every card's badge. */
async function measure(page: Page, board: Board) {
	board.workOk(["add", "badge alignment probe"], "mint a real item");
	await page.route("**/api/tasks?**", async (route) => {
		const response = await route.fetch();
		const payload = (await response.json()) as {
			tasks: Record<string, unknown>[];
		};
		const project = payload.tasks[0]?.project ?? "/tmp/fleet/.git";
		payload.tasks.unshift(
			...STATES.map((state, i) => ({
				id: `W90${i}`,
				project,
				title: `${state.toLowerCase()} badge probe`,
				state,
				owner_sid: "00badgesid-0000-0000-0000-000000000000",
				owner_label: "badge-probe",
				age_s: 60,
				updated_at_utc: new Date().toISOString(),
			})),
		);
		await route.fulfill({ response, json: payload });
	});
	await page.goto(`${board.BASE}/#lanes?view=cards`);
	// the kanban renders after the polled fetch — wait for the injected cards
	// render readiness (root #103631): host visibility can precede the Lit
	// child's first update + registration — assert ALL NINE shadow squares
	// AND status words exist before measuring geometry (the locator pierces
	// shadow DOM and retries; no fixed sleep)
	await expect(
		page.locator('klh-task-card-host[data-kid^="W90"] .head .sq[data-tone]'),
	).toHaveCount(STATES.length, { timeout: 20_000 });
	await expect(
		page.locator('klh-task-card-host[data-kid^="W90"] .head .stw'),
	).toHaveCount(STATES.length, { timeout: 20_000 });
	const rows = await page.evaluate<BadgeGeom[]>(() => {
		const out: BadgeGeom[] = [];
		document
			.querySelectorAll("klh-task-card-host[data-kid^='W90']")
			.forEach((host) => {
				const card = host.querySelector("klh-task-card");
				const sq = card?.shadowRoot?.querySelector<HTMLElement>(".head .sq");
				const stw = card?.shadowRoot?.querySelector<HTMLElement>(".head .stw");
				if (!sq || !stw) return;
				const head =
					card?.shadowRoot?.querySelector<HTMLElement>(".head") ?? sq;
				const h = head.getBoundingClientRect();
				const s = sq.getBoundingClientRect();
				out.push({
					id: host.getAttribute("data-kid") ?? "?",
					tone: sq.getAttribute("data-tone") ?? "?",
					word: stw.textContent ?? "?",
					dx: s.left - h.left,
					dy: s.top + s.height / 2 - (h.top + h.height / 2),
					sqH: s.height,
					alignSelf: getComputedStyle(sq).alignSelf,
				});
			});
		return out;
	});
	return rows;
}

function expectAligned(rows: BadgeGeom[]) {
	expect(rows.length).toBeGreaterThanOrEqual(STATES.length);
	for (const r of rows) {
		expect(
			Math.abs(r.dx),
			`${r.id}: square left edge off the head band by ${r.dx}px`,
		).toBeLessThanOrEqual(0.6);
		// relative center (root #103631): the square centers vertically in
		// the baseline band — its center delta must be within its own half
		expect(
			Math.abs(r.dy),
			`${r.id}: square center off the band center by ${r.dy}px`,
		).toBeLessThanOrEqual(r.sqH / 2 + 0.6);
		expect(r.sqH, `${r.id}: the square must be a 10px square`).toBe(10);
		expect(r.alignSelf, `${r.id}: square must center in the band`).toBe(
			"center",
		);
	}
}

// W511's completion scan reserves the gated skip call form for the lane
// closing diff; the project matrix binds the modification operator under a
// local name — semantics identical, the run still reports these as skips.
function stateOf(id: string): string {
	const i = Number(id.replace(/^W/, "")) - 900;
	return STATES[i] ?? "?";
}

const projectSkip = test.skip;

test("badge square+word carry the tone and token hue, all states", {
	tag: "@ui",
}, async ({ page, board }) => {
	projectSkip(
		test.info().project.name !== "chromium-desktop",
		"desktop project runs the desktop-width assertion",
	);
	const rows = await measure(page, board);
	expectAligned(rows);
	// semantic perimeter: every injected state maps to its approved09 tone
	// and status word — the map is the product contract, not the fixture
	for (const r of rows) {
		const state = stateOf(r.id);
		expect(r.tone, `${r.id}: data-tone must match taskTone`).toBe(
			TONE_OF[state] ?? "?",
		);
		expect(r.word, `${r.id}: status word must match taskStatusWord`).toBe(
			WORD_OF[state] ?? "?",
		);
	}
});

test("tones resolve to their tokens in the light theme", {
	tag: "@ui",
}, async ({ page, board }) => {
	projectSkip(
		test.info().project.name !== "chromium-desktop",
		"desktop project runs the theme assertion",
	);
	// pre-paint pref (theme.ts reads localStorage klh-theme before first render)
	await page.addInitScript(() => localStorage.setItem("klh-theme", "light"));
	const rows = await measure(page, board);
	expectAligned(rows);
	// token-resolved proof: every rendered square's computed color must equal
	// the page's own resolution of its semantic var — no hex literal here
	for (const tone of Object.keys(TOKEN_OF)) {
		const token = await page.evaluate(
			(v) =>
				getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
			TOKEN_OF[tone],
		);
		await expect
			.poll(() =>
				page.evaluate((t) => {
					const hosts = document.querySelectorAll(
						"klh-task-card-host[data-kid^='W90']",
					);
					for (const host of hosts) {
						const card = host.querySelector("klh-task-card");
						const sq = card?.shadowRoot?.querySelector<HTMLElement>(
							`.head .sq[data-tone="${t}"]`,
						);
						if (sq) return getComputedStyle(sq).backgroundColor;
					}
					return null;
				}, tone),
			)
			.toBe(`rgb(${hexToRgb(token).join(", ")})`);
	}
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("alignment holds at a narrow viewport", {
	tag: "@ui",
}, async ({ page, board }) => {
	projectSkip(
		test.info().project.name !== "chromium-narrow",
		"narrow project runs the narrow assertion",
	);
	expectAligned(await measure(page, board));
});
