// e2e/w998-card-drawer.spec.ts — W998: the work card renders a COMPACT
// relative update stamp (full instant on hover, no wide DD.MM.YY HH:MM) and
// the failed-item drawer shows the FULL failure note unclamped. Real board +
// scratch HOME via the startBoard harness (board-spend-series.spec.ts
// pattern); the failure note rides `work fail --note` so the /api/tasks
// feed carries it like production.
import { expect, test } from "@playwright/test";
import { startBoard } from "./harness.ts";

const NOTE =
	"launch budget exhausted after 3 backoff rounds; upstream 429 wall held for the whole routing walk and the retry queue deadline cascaded";

test.describe.configure({ mode: "serial" });

let b: Awaited<ReturnType<typeof startBoard>>;
let wId = "";

test.beforeAll(async () => {
	b = await startBoard("w998", {});
	wId = b.mintedId(b.workOk(["add", "w998 card drawer item"], "add"));
	b.workOk(["take", wId, "--as", "autow998-e2e"], "take");
	b.workOk(["fail", wId, "--note", NOTE], "fail");
});

test.afterAll(async () => {
	await b.stop();
});

test("gui: work card stamps the update age compactly, full instant on hover", async ({
	page,
}) => {
	await page.goto(`${b.BASE}/#lanes`);
	const stamp = page
		.locator(`.kcard[data-kid="${wId}"] .kcardstamp time`)
		.first();
	await expect(stamp).toBeVisible({ timeout: 20_000 });
	// compact relative label — never the wide absolute DD.MM.YY HH:MM stamp
	await expect(stamp).toHaveText(/^\d+[smhd]$/);
	const stampHtml = await stamp.evaluate((el) => el.outerHTML);
	expect(stampHtml).not.toMatch(/\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}/);
	// the full instant survives as the <time> tooltip
	expect(stampHtml).toMatch(/title="updated [^"]+ · UTC /);
	// the card age keeps its open-age tooltip next to the id
	const age = page
		.locator(`.kcard[data-kid="${wId}"] .kage`)
		.first();
	await expect(age).toHaveText(/^\d+[smhd]$/);
	expect(await age.getAttribute("title")).toMatch(/^open /);
});

test("gui: failed-item drawer renders the full failure note unclamped", async ({
	page,
}) => {
	await page.goto(`${b.BASE}/#lanes`);
	await page.locator(`.kcard[data-kid="${wId}"] .tidbtn`).first().click();
	const drawer = page.locator("#drawer");
	await expect(drawer).toBeVisible({ timeout: 20_000 });
	const para = page.locator("#drawerBody .failure-detail p").first();
	await expect(para).toContainText(
		"launch budget exhausted after 3 backoff rounds",
	);
	// the SECOND `;` segment proves nothing was sliced off for the drawer
	await expect(para).toContainText(
		"retry queue deadline cascaded",
	);
	// no line clamp on the drawer paragraph — long notes wrap instead
	const clamp = await para.evaluate(
		(el) => getComputedStyle(el).webkitLineClamp,
	);
	expect(clamp === "none" || clamp === "").toBe(true);
});
