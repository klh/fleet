// e2e/board-ent-zone.spec.ts — W775.1: the enterprise board zone, live.
// Core SKU: no Enterprise tab, /api/entitlements answers the honest 501,
// #enterprise deep-links coerce to Decisions. Entitled board (the
// KLH_OVERLAY_MODULE fixture provider): the tab appears, the zone renders
// the seven panels with real slice data, a failed slice renders its
// honest empty-state.
// W1136: rides the shared fixtures — board (core SKU world) + peerBoard
// (the W775.1 overlay fixture world via peerBoardOptions), the api fixture,
// and the auto pageWatcher; the beforeAll(startBoard) copies are gone. The
// seven-panel host check is parameterized (test.each).
import { join } from "node:path";
import { expect, test } from "./fixtures";

test.use({
	peerBoardOptions: {
		env: { KLH_OVERLAY_MODULE: join(import.meta.dir, "ent-fixture-module.ts") },
	},
});

test("core SKU: seam routes 501, no tab, no zone", async ({ api }) => {
	const r = await api.get("/api/entitlements");
	expect(r.status()).toBe(501);
	const j = (await r.json()) as { ok: boolean; code: string };
	expect(j.ok).toBe(false);
	expect(j.code).toBe("board.no_enterprise_overlay");
	const e = await api.get("/api/enterprise");
	expect(e.status()).toBe(501);
});

test("core SKU: page hides the zone and coerces the deep-link", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	await expect(tabs).toBeVisible();
	// the seven core tabs only — the enterprise tab never appears
	await expect(tabs.getByRole("button")).toHaveCount(7);
	// the section exists but stays hidden
	await expect(page.locator("#tab-enterprise")).toBeHidden();

	// a #enterprise deep-link on a core board lands on Decisions
	await page.goto(`${board.BASE}/#enterprise`);
	await expect(page.locator("klh-board-tabs button[aria-current]")).toHaveText(
		"Decisions",
	);
	await expect(page.locator("#tab-enterprise")).toBeHidden();
});

test("entitled: tab appears, zone renders the seven panels", async ({
	page,
	peerBoard,
}, testInfo) => {
	testInfo.setTimeout(40_000);
	await page.goto(`${peerBoard.BASE}/`);
	const tabs = page.locator("klh-board-tabs");
	const entBtn = tabs.getByRole("button", { name: "Enterprise" });
	await expect(entBtn).toBeVisible({ timeout: 20_000 });

	await entBtn.click();
	const zone = page.locator("#tab-enterprise klh-ent-zone");
	await expect(zone).toBeVisible();
	await expect(zone).toHaveAttribute("active", "");

	// zone chrome: badge + tenant
	await expect(zone.locator(".badge")).toHaveText("ENTERPRISE");
	await expect(zone.locator(".tenant")).toHaveText("acme-corp");

	// the seven family panels render (one host each)
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
		.screenshot({ path: `/tmp/w7751-zone-${testInfo.retry}.png` })
		.catch(() => {});
});

// the seven family panels render one host each (W1136: parameterized —
// the old spec ran this as a for-loop inside the entitled test)
for (const tag of [
	"klh-ent-identity",
	"klh-ent-federation",
	"klh-ent-audit",
	"klh-ent-usage",
	"klh-ent-policy",
	"klh-ent-vault",
	"klh-ent-ma",
]) {
	test(`entitled: panel ${tag} renders exactly one host`, async ({
		page,
		peerBoard,
	}) => {
		await page.goto(`${peerBoard.BASE}/`);
		const entBtn = page
			.locator("klh-board-tabs")
			.getByRole("button", { name: "Enterprise" });
		await expect(entBtn).toBeVisible({ timeout: 20_000 });
		await entBtn.click();
		const zone = page.locator("#tab-enterprise klh-ent-zone");
		await expect(zone).toBeVisible();
		await expect(zone.locator(tag)).toHaveCount(1);
	});
}
