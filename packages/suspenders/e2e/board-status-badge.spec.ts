// e2e/board-status-badge.spec.ts — W998.1: the kanban status badge is a
// corner tab — its outline must sit ON the card's top and left border, for
// every state (the rule is shared), in both themes and at both a desktop and
// a narrow viewport. Measured geometry (getBoundingClientRect), not strings.
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

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

interface BadgeGeom {
	id: string;
	dx: number;
	dy: number;
	alignSelf: string;
}

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-status-badge");
	board.workOk(["add", "badge alignment probe"], "mint a real item");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

/** Inject one synthetic task per state, then measure every card's badge. */
async function measure(page: import("@playwright/test").Page) {
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
	await page.goto(`${mustBoard().BASE}/#lanes`);
	// the kanban renders after the polled fetch — wait for the injected cards
	await page
		.locator('.kcard[data-kid^="W90"]')
		.first()
		.waitFor({ state: "visible" });
	const rows = await page.evaluate<BadgeGeom[]>(() => {
		const out: BadgeGeom[] = [];
		document.querySelectorAll(".kcard").forEach((card) => {
			const pill = card.querySelector<HTMLElement>(".krow .pill");
			if (!pill) return;
			const c = card.getBoundingClientRect();
			const p = pill.getBoundingClientRect();
			out.push({
				id: card.getAttribute("data-kid") ?? "?",
				dx: p.left - c.left,
				dy: p.top - c.top,
				alignSelf: getComputedStyle(pill).alignSelf,
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
			`${r.id}: badge left edge off the card border by ${r.dx}px`,
		).toBeLessThanOrEqual(0.6);
		expect(
			Math.abs(r.dy),
			`${r.id}: badge top edge off the card border by ${r.dy}px`,
		).toBeLessThanOrEqual(0.6);
		expect(r.alignSelf, `${r.id}: badge must pin to the row top`).toBe(
			"flex-start",
		);
	}
}

test("badge outline aligns with the card top-left border, all states", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	expectAligned(await measure(page));
});

test("alignment holds in the light theme", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	// pre-paint pref (theme.ts reads localStorage klh-theme before first render)
	await page.addInitScript(() => localStorage.setItem("klh-theme", "light"));
	expectAligned(await measure(page));
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("alignment holds at a narrow viewport", async ({ page }) => {
	await page.setViewportSize({ width: 480, height: 800 });
	expectAligned(await measure(page));
});
