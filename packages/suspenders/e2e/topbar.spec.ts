// e2e/topbar.spec.ts — W658.2: the klh-topbar shared Lit base, render-and-look
// against a real fleet-board.ts (scratch HOME, dead upstreams). The component
// owns the console bar in shadow DOM: avatar dropdown (me via /api/console/me),
// settings gear (theme radios on window.klhTheme), and the light-DOM fleet
// strip that every page wears above it. Screenshots land in /tmp/w658-shots.
// W1136: rides the shared fixtures — worker board + the auto pageWatcher
// (the local watch() copy is gone); the beforeAll(startBoard) copy is gone
// and the six-surface nav walk is parameterized into its own tests.
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = "/tmp/w658-shots";
mkdirSync(SHOTS, { recursive: true });

const bar = (page: Page) => page.locator("klh-topbar");

test("klh-topbar upgrades on the board, belt console and usage page", async ({
	page,
	board,
}) => {
	// board (/) — fetch path: avatar shows "?" until /api/console/me lands
	await page.goto(`${board.BASE}/`);
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
	await page.goto(`${board.BASE}/console/buckle`);
	await expect(bar(page).locator(".cavbtn")).toBeVisible();
	await expect(page.locator("h1.ptitle")).toHaveText("Buckle gateway");
	await page.screenshot({ path: `${SHOTS}/2-belt.png`, fullPage: true });

	// usage — no me attr, the component fetches again
	await page.goto(`${board.BASE}/usage`);
	await expect(bar(page).locator(".cavbtn")).toBeVisible();
	await expect(page.locator("h1.utitle")).toHaveText("USAGE");
	await page.screenshot({ path: `${SHOTS}/3-usage.png`, fullPage: true });
});

test("settings gear: theme radios flip data-theme on the document", async ({
	page,
	board,
}) => {
	// the settings link is slotted only on console pages — drive there
	await page.goto(`${board.BASE}/console/buckle`);
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
});

// W858.3: the fleet strip is ONE navigation for belt / gateway / local /
// hub-admin / settings across every surface; the board's gear panel now
// carries the console-settings link too (parity with the console pages).
const NAV_VIEWS = [
	"Models",
	"Routes",
	"Workflows",
	"Services",
	"Metrics",
	"Hub",
	"Settings",
] as const;

// one minted test per surface (W1136: the old spec walked all six in a
// single test with a manual for-loop over path/current pairs)
const SURFACES = [
	["/", "Workflows"],
	["/console/buckle", "Routes"],
	["/console/local", "Services"],
	["/console/hub", "Hub"],
	["/console/settings", "Settings"],
	["/#usage", "Workflows"],
] as const;

for (const [path, current] of SURFACES) {
	test(`W858.3: the fleet strip unifies the nav on ${path}`, async ({
		page,
		board,
	}) => {
		await page.goto(`${board.BASE}${path}`);
		const strip = page.locator("nav.klh-fleetnav");
		await expect(strip).toBeVisible();
		for (const label of NAV_VIEWS)
			await expect(strip.getByRole("link", { name: label })).toBeVisible();
		// aria-current lands on the surface's own view (null = none)
		for (const label of NAV_VIEWS) {
			const link = strip.getByRole("link", { name: label });
			if (label === current)
				await expect(link).toHaveAttribute("aria-current", "page");
			else await expect(link).not.toHaveAttribute("aria-current");
		}
	});
}

test("W858.3: strip hrefs and the board gear panel carry console-settings (slot parity)", async ({
	page,
	board,
}) => {
	// Hub → /console/hub, Settings → /console/settings (board = relative hrefs)
	await page.goto(`${board.BASE}/`);
	const strip = page.locator("nav.klh-fleetnav");
	await expect(strip.getByRole("link", { name: "Hub" })).toHaveAttribute(
		"href",
		"/console/hub",
	);
	await expect(strip.getByRole("link", { name: "Settings" })).toHaveAttribute(
		"href",
		"/console/settings",
	);
	// the board's gear panel carries the console-settings link (slot parity)
	await bar(page).locator(".klh-settings > summary").click();
	await expect(
		bar(page).getByRole("link", { name: /all console settings/ }),
	).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/5-w8583-strip.png` });
});
