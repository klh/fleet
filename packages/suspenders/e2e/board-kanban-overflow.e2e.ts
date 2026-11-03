// e2e/board-kanban-overflow.e2e.ts — W2672 secondary: the kanban's
// horizontal affordance. The board renders 7-8 fixed-width columns inside
// .kwrap (overflow-x:auto) — on macOS overlay scrollbars the rail is
// invisible until a gesture, so columns past the viewport edge (BLOCKED
// first) read as "cut off at the right edge". Pinned contract:
//   1. .kwrap carries a stable thin scrollbar (scrollbar-width:thin — a
//      visible affordance, no height lurch when it appears),
//   2. the status-nav jump scroll brings ANY column fully into view,
//   3. the overflow stays inside the wrap — the page itself never grows a
//      horizontal scrollbar.
import { expect, test } from "./fixtures";

// #100627: the board process must NEVER reach the live governor store.
test.use({ boardOptions: { env: { GOVERNOR_STORE_URL: "local" } } });

test("kanban overflow rides a visible wrap scrollbar, never the page", {
	tag: "@ui",
}, async ({ page, board }) => {
	await page.goto(`${board.BASE}/#lanes`);
	await page.locator(".kcol").first().waitFor({ state: "visible" });
	const facts = await page.evaluate(() => {
		const wrap = document.querySelector(".kwrap");
		if (!wrap) throw new Error("kwrap missing");
		const cs = getComputedStyle(wrap);
		return {
			overflowX: cs.overflowX,
			scrollbarWidth: cs.scrollbarWidth,
			wrapScrolls: wrap.scrollWidth > wrap.clientWidth,
			docScrolls:
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth,
		};
	});
	expect(facts.overflowX).toBe("auto");
	// the affordance is a STABLE thin rail (not overlay-invisible)
	expect(facts.scrollbarWidth, "visible scrollbar affordance").toBe("thin");
	// when columns overflow, it is the WRAP that scrolls — the page never does
	if (facts.wrapScrolls) expect(facts.docScrolls).toBe(false);
});

test("status-nav jump brings the last column fully into view", {
	tag: "@ui",
}, async ({ page, board }) => {
	await page.goto(`${board.BASE}/#lanes`);
	await page.locator(".kcol").first().waitFor({ state: "visible" });
	const jumps = page.locator("#kstatusnav button[data-kcol]");
	const count = await jumps.count();
	// the seeded world always renders the status columns (hideEmpty columns
	// with items stay) — fewer than 2 jumps means the nav never built
	expect(count, "status-nav jump buttons rendered").toBeGreaterThanOrEqual(2);
	// click the LAST jump (the rightmost column — the one clipping complained about)
	await jumps.nth(count - 1).click();
	await page.waitForTimeout(900); // smooth scroll settles
	const visible = await page.evaluate(() => {
		const cols = [...document.querySelectorAll(".kcol")];
		const last = cols[cols.length - 1];
		if (!last) throw new Error("no columns rendered");
		const r = last.getBoundingClientRect();
		return {
			key: last.getAttribute("data-kcol-key"),
			fullyVisible: r.right <= innerWidth + 1 && r.left >= -1,
			right: Math.round(r.right),
			innerWidth,
		};
	});
	expect(visible.fullyVisible, `last column ${visible.key} in view`).toBe(true);
});
