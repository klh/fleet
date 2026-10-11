// e2e/topbar.spec.ts — W658.2: the klh-topbar shared Lit base, render-and-look
// against a real fleet-board.ts (scratch HOME, dead upstreams). The component
// owns the console bar in shadow DOM: avatar dropdown (me via /api/console/me),
// settings gear (theme radios on window.klhTheme), and the light-DOM fleet
// strip that every page wears above it. Screenshots land in /tmp/w658-shots.
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

const SHOTS = "/tmp/w658-shots";

let board: Board | null = null;

test.beforeAll(async () => {
	mkdirSync(SHOTS, { recursive: true });
	board = await startBoard("topbar");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

function watch(page: Page): { clean(): void } {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	return {
		clean(): void {
			expect(pageErrors, "uncaught page exceptions").toEqual([]);
			expect(consoleErrors, "console errors").toEqual([]);
		},
	};
}

const bar = (page: Page) => page.locator("klh-topbar");

test("klh-topbar upgrades on the board, belt console and usage page", async ({
	page,
}) => {
	const B = mustBoard();
	const look = watch(page);

	// board (/) — fetch path: avatar shows "?" until /api/console/me lands
	await page.goto(`${B.BASE}/`);
	await expect(bar(page)).toBeVisible();
	const strip = page.locator("nav.klh-fleetnav");
	await expect(strip).toBeVisible();
	const stripBox = await strip.boundingBox();
	const barBox = await bar(page).boundingBox();
	expect(stripBox?.y ?? 0).toBeLessThan(barBox?.y ?? 999);
	const avatar = bar(page).locator(".cavbtn");
	await expect(avatar).toBeVisible();
	await expect(bar(page).locator(".cavdrop")).toBeHidden();
	// me resolved from the API: the panel carries the actor (scratch HOME →
	// unassigned) and the demo select
	await avatar.click();
	await expect(bar(page).locator(".cavdrop")).toBeVisible();
	await expect(bar(page).locator(".cavname")).toHaveText(/unassigned|loading/);
	await expect(
		bar(page).getByRole("combobox", { name: "switch actor (demo preview)" }),
	).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/1-board-dropdown.png` });
	await page.keyboard.press("Escape");
	await expect(bar(page).locator(".cavdrop")).toBeHidden();
	// Escape returns focus to the toggle (keyboard reachability)
	await expect(avatar).toBeFocused();

	// belt console — server-rendered me attr rides the same component
	await page.goto(`${B.BASE}/console/belt`);
	await expect(bar(page).locator(".cavbtn")).toBeVisible();
	await expect(page.locator("h1.ptitle")).toHaveText("Belt gateway");
	await page.screenshot({ path: `${SHOTS}/2-belt.png`, fullPage: true });

	// usage — no me attr, the component fetches again
	await page.goto(`${B.BASE}/usage`);
	await expect(bar(page).locator(".cavbtn")).toBeVisible();
	await expect(page.locator("h1.utitle")).toHaveText("USAGE");
	await page.screenshot({ path: `${SHOTS}/3-usage.png`, fullPage: true });

	look.clean();
});

test("settings gear: theme radios flip data-theme on the document", async ({
	page,
}) => {
	const B = mustBoard();
	const look = watch(page);
	// the settings link is slotted only on console pages — drive there
	await page.goto(`${B.BASE}/console/belt`);
	await expect(bar(page)).toBeVisible();
	const gear = bar(page).locator(".klh-settings > summary");
	await gear.click();
	const panel = bar(page).locator(".klh-settings-panel");
	await expect(panel).toBeVisible();
	// the slotted page link rides the slot into the panel — asserted at the
	// component level (chained panel.locator() misses projected slot content)
	await expect(
		bar(page).getByRole("link", { name: /all console settings/ }),
	).toBeVisible();
	// dark is the no-JS default; picking light flips the document attribute
	await panel.getByRole("radio", { name: "light" }).check();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await page.screenshot({ path: `${SHOTS}/4-settings-light.png` });
	await panel.getByRole("radio", { name: "system" }).check();
	await gear.click();
	look.clean();
});
