// e2e/board-setup-lit.e2e.ts — W2550.3: the setup tab as a Lit feature
// (klh-setup leaf + klh-setup-mediator) in a REAL browser. Pins the
// contracts the retired SETUP chunk owned: the W858.7.21 grouped checklist
// renders (Local wiring vs Remote reachability, no check hidden), the
// summary counts, the W852 seed paints cards on first paint (no loading
// flash), the copy-fix button asks the mediator (clipboard permission is
// denied in headless Chromium — the toast rides the failure leg, proving
// the typed event reached the mediator), and the error state names the
// last-good age. pageWatcher asserts no uncaught exceptions. Watcher
// exemptions (named here, per the fixtures contract): the banner test's
// route-intercepted /api/setup 404 rides watcherAllow404 — the wire really
// carried it and the resource-load line is the designed condition.
import { expect, test } from "./fixtures";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });

// dead loopback candidate (port 9) as the only hub candidate — the
// reachability check fails with a concrete recovery path carrying a fix
// (the setup-groups.spec.ts fixture idiom)
const cfgDir = mkdtempSync(join(tmpdir(), "sb-e2e-litfix-cfg-"));
const hubsPath = join(cfgDir, "hubs.json");
writeFileSync(
	hubsPath,
	`${JSON.stringify({ nas: { candidates: ["http://127.0.0.1:9"] } }, null, "\t")}\n`,
);

test.afterAll(() => {
	rmSync(cfgDir, { recursive: true, force: true });
});

test.use({
	cleanBoardOptions: { env: { SUSPENDERS_HUBS_FILE: hubsPath } },
	watcherAllow404: /\/api\/setup(\?|$)/,
});

test("seeded checklist paints on first paint, grouped, nothing hidden", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/#setup`);
	// W852: seeded synchronously from window.__SETUP__ — no fetch wait
	await expect(page.locator("#setupBody .scard").first()).toContainText(
		"Control-plane database",
	);
	// the loading placeholder never shows — the seed beat it
	await expect(page.getByText("loading setup checks...")).toHaveCount(0);
	// W858.7.21: both group headings paint with their counts
	await expect(page.locator("#setupBody h3.sgroup").first()).toHaveText(
		/Local wiring \(\d+\)/,
	);
	// the two counts sum to the full checklist (no check hidden)
	const groups = page.locator("#setupBody h3.sgroup");
	const count = await groups.count();
	const sums: number[] = [];
	for (let i = 0; i < count; i++) {
		const t = (await groups.nth(i).textContent()) ?? "";
		sums.push(Number(t.match(/\((\d+)\)/)?.[1] ?? 0));
	}
	const total = sums.reduce((a, b) => a + b, 0);
	await expect(page.locator("#setupBody .scard")).toHaveCount(total);
	// the summary line mirrors the same total
	await expect(page.locator("#setupSummary")).toContainText(/total|passing/);
});

test("copy-fix rides the typed event to the mediator", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/#setup`);
	// the dead hub's failed card carries the concrete recovery command
	const card = page.locator("#setupBody .scard", {
		hasText: "Hub reachability",
	});
	await expect(card).toContainText("nas no answer at http://127.0.0.1:9", {
		timeout: 15_000,
	});
	const btn = card.locator(".copyfix");
	// the fix command rides the data-fix attribute (the old chunk contract)
	await expect(btn).toHaveAttribute(
		"data-fix",
		"bun deploy/hubctl.ts status nas",
	);
	// headless Chromium denies clipboard-write → the failure toast proves
	// the event crossed the mediator (not a silent no-op)
	await btn.click();
	await expect(page.locator("#toasts .toast").first()).toContainText(
		/copy|clipboard/,
	);
});

test("feed failure surfaces the honest banner with last-good age", async ({
	page,
	cleanBoard,
}) => {
	await page.goto(`${cleanBoard.BASE}/#setup`);
	// first: a good load (the seed) so a last-good age exists
	await expect(page.locator("#setupBody .scard").first()).toBeVisible();
	// fail the wire mid-look: /api/setup answers the designed 404 (the
	// watcherAllow404 exemption, named in this file's header) — the next
	// poll fails, the banner names the last-good age, cards stay visible
	await page.route("**/api/setup", (route) =>
		route.fulfill({
			status: 404,
			contentType: "application/json",
			body: JSON.stringify({ ok: false }),
		}),
	);
	await expect(page.locator("#setupErr")).toContainText(
		/setup checks unavailable — last good/,
		{ timeout: 20_000 },
	);
	// last-good payload stays visible (never a blank pane on later failures)
	await expect(page.locator("#setupBody .scard").first()).toBeVisible();
	// close the page's streams before the per-test board teardown — the
	// SSE/feed sockets otherwise break as console noise at watcher assert
	await page.goto("about:blank");
});
