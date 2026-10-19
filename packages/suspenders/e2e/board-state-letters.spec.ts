// e2e/board-state-letters.spec.ts — W891: the state letter (F red, R blue,
// D green, Q gray) renders on the live board with the demo fleet: the tasks
// table pills and the fleet lanes rows both carry the .stl letter, and each
// computed color resolves to the matching klh semantic token — never a
// literal. Read against the shipped bytes; screenshots land in test-results.
import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-state-letters", { args: ["--demo"] });
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

// token-resolved proof: the letter's computed color must equal the page's
// own resolution of the semantic var — no hex literal in this spec
async function tokenColor(page: import("@playwright/test").Page, name: string) {
	return page.evaluate((v) => {
		return getComputedStyle(document.documentElement)
			.getPropertyValue(v)
			.trim();
	}, name);
}

function hexToRgb(hex: string): string {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a 6-digit hex token: ${hex}`);
	const n = parseInt(m[1], 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test("tasks table: pills carry state letters in the semantic hues", async ({
	page,
}) => {
	const b = mustBoard();
	// DONE rows are opt-in (taskShowDone) — surface them so the D letter renders
	await page.addInitScript(() => localStorage.setItem("taskShowDone", "1"));
	await page.goto(`${b.BASE}/#tasks`);
	const table = page.locator("#tasksBody");
	await expect(table.locator("tr").first()).toBeVisible();
	// the letter leads every state pill
	const pills = table.locator(".pill");
	await expect(pills.first()).toBeVisible();
	const count = await pills.count();
	expect(count).toBeGreaterThan(0);
	for (let i = 0; i < count; i++) {
		await expect(pills.nth(i).locator("b.stl").first()).toHaveText(/^[A-Z?]$/);
	}
	// the owner-named letters resolve to their tokens where the demo has
	// them: R (READY) info, D (DONE) ok, B (BLOCKED) shares F's danger token —
	// the demo seeds no FAILED item (F/Q live in the chunk unit tests)
	const token: Record<string, string> = {
		R: await tokenColor(page, "--klh-info"),
		D: await tokenColor(page, "--klh-ok-ink"),
		B: await tokenColor(page, "--klh-danger-ink"),
	};
	for (const [letter, hex] of Object.entries(token)) {
		const letter$ = table.locator("b.stl", { hasText: letter }).first();
		await expect
			.poll(async () => {
				if ((await letter$.count()) === 0) return null;
				return letter$.evaluate((el) => getComputedStyle(el).color);
			})
			.toBe(hexToRgb(hex));
	}
	await page.screenshot({ path: "test-results/w891-tasks-letters.png" });
});

test("tasks filters use the shared project scope and retain column sorting", async ({
	page,
}) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#tasks`);
	await expect(page.locator("#proj")).toHaveCount(1);
	await expect(page.locator("#taskProj")).toHaveCount(0);
	const all = page.locator('#taskFocus [data-focus="all"]');
	await expect(all).toHaveAttribute("aria-pressed", "true");
	await page.locator('#taskFocus [data-focus="ready"]').click();
	await expect(page.locator('#taskFocus [data-focus="ready"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	const rows = page.locator("#tasksBody tr[data-tid]");
	await expect(rows.first()).toBeVisible();
	const states = await rows.locator(".pill").allTextContents();
	expect(states.every((state) => state.toLowerCase().includes("ready"))).toBe(
		true,
	);
	await all.click();
	await page.locator('#tasksTbl th[data-k="owner"] button').click();
	await expect(page.locator("#taskPriority")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await page.locator("#taskPriority").click();
	await expect(page.locator("#taskPriority")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("fleet lanes rows: the status word leads with its letter", async ({
	page,
}) => {
	const b = mustBoard();
	await page.goto(`${b.BASE}/#governor`);
	// the fleet strip ships collapsed — expand before asserting rows
	await page.click("#fleetHead");
	const rows = page.locator(".fleetrow");
	await expect(rows.first()).toBeVisible();
	const n = await rows.count();
	expect(n).toBeGreaterThan(0);
	for (let i = 0; i < n; i++) {
		const st = rows.nth(i).locator(".fleetstate");
		const first = st.locator("b.stl").first();
		await expect(first).toHaveText(/^[A-Z?]$/);
		// the letter is the status word's initial
		const word = (await st.textContent()) ?? "";
		const initial = word.charAt(0).toUpperCase();
		await expect(first).toHaveText(initial);
	}
	await page.screenshot({ path: "test-results/w891-fleet-letters.png" });
});
