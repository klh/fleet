// e2e/board-ent-zone.spec.ts — W775.1: the enterprise board zone, live.
// Core SKU: no Enterprise tab, /api/entitlements answers the honest 501,
// #enterprise deep-links coerce to Decisions. Entitled board (the
// KLH_OVERLAY_MODULE fixture provider): the tab appears, the zone renders
// the seven panels with real slice data, a failed slice renders its
// honest empty-state.

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let entBoard: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("board-ent-core");
	entBoard = await startBoard("board-ent-overlay", {
		env: {
			KLH_OVERLAY_MODULE: join(import.meta.dir, "ent-fixture-module.ts"),
		},
	});
});

test.afterAll(async () => {
	if (board) await board.stop();
	if (entBoard) await entBoard.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

function mustEnt(): Board {
	if (entBoard === null) throw new Error("ent board not started");
	return entBoard;
}

test("core SKU: seam routes 501, no tab, no zone", { tag: "@ui" }, async ({
	request,
}) => {
	const r = await request.get(`${mustBoard().BASE}/api/entitlements`);
	expect(r.status()).toBe(501);
	const j = (await r.json()) as { ok: boolean; code: string };
	expect(j.ok).toBe(false);
	expect(j.code).toBe("board.no_enterprise_overlay");
	const e = await request.get(`${mustBoard().BASE}/api/enterprise`);
	expect(e.status()).toBe(501);
});

test("core SKU: page hides the zone and coerces the deep-link", {
	tag: "@ui",
}, async ({ page }) => {
	await page.goto(`${mustBoard().BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await expect(tabs).toBeVisible();
	// the seven core tabs only (W1294.2: Usage joined) — no enterprise tab
	await expect(tabs.getByRole("button")).toHaveCount(7);
	// the section exists but stays hidden
	await expect(page.locator("#tab-enterprise")).toBeHidden();

	// a #enterprise deep-link on a core board lands on Decisions
	await page.goto(`${mustBoard().BASE}/#enterprise`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Decisions",
	);
	await expect(page.locator("#tab-enterprise")).toBeHidden();
});

test("entitled: tab appears, zone renders the seven panels", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustEnt().BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	const entBtn = tabs.getByRole("button", { name: "Enterprise" });
	await expect(entBtn).toBeVisible({ timeout: 20_000 });
	expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);

	await entBtn.click();
	const zone = page.locator("#tab-enterprise klh-ent-zone");
	await expect(zone).toBeVisible();
	await expect(zone).toHaveAttribute("active", "");

	// zone chrome: badge + tenant
	await expect(zone.locator(".badge")).toHaveText("ENTERPRISE");
	await expect(zone.locator(".tenant")).toHaveText("acme-corp");

	// the seven family panels render (one host each)
	for (const tag of [
		"klh-ent-identity",
		"klh-ent-federation",
		"klh-ent-audit",
		"klh-ent-usage",
		"klh-ent-policy",
		"klh-ent-vault",
		"klh-ent-ma",
	]) {
		await expect(zone.locator(tag)).toHaveCount(1);
	}
	await expect(
		zone.locator("klh-ent-identity h3", { hasText: "Identity" }),
	).toBeVisible();

	// identity slice data is real: ada (employee, enforced) + bob
	// (contractor, off)
	const identity = zone.locator("klh-ent-identity");
	await expect(identity.locator("td", { hasText: "ada" })).toBeVisible();
	await expect(
		identity.locator(".chip", { hasText: "contractor" }),
	).toBeVisible();
	await expect(
		identity.locator(".chip", { hasText: "enforced" }),
	).toBeVisible();

	// usage anomaly flags
	await expect(
		zone.locator("klh-ent-usage .chip", { hasText: "flag" }),
	).toBeVisible();

	// failed slice renders its honest why (vault)
	await expect(
		zone.locator("klh-ent-vault .state.bad", {
			hasText: "vault surface not wired",
		}),
	).toBeVisible();

	// the render-and-look artifact (not committed — lane evidence)
	await page
		.locator("#tab-enterprise")
		.screenshot({ path: "/tmp/w7751-zone.png" })
		.catch(() => {});
});
