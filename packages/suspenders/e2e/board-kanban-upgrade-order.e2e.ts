// e2e/board-kanban-upgrade-order.e2e.ts — W2672: the stale-Lit-render
// regression. The live board served a dev-mode lit reactive-element chunk
// (W2587's merge-time reformat) whose static methods bound the lexical
// base class instead of `this`, so `observedAttributes` finalized ONLY
// ReactiveElement — the host subclass never installed property accessors
// (`elementProperties` empty). kanbanCardSync then wrote `el.t = task` onto
// the not-yet-upgraded element as a plain own property, the upgrade-time
// constructor clobbered it with `this.t = null`, and every later write was
// a dead plain assignment (no accessor → no requestUpdate): every kanban
// card rendered the honest-invalid note. This spec pins BOTH halves of the
// contract against the served vendor bundle:
//   1. a host whose properties are assigned BEFORE the custom element
//      upgrade renders the card once defined (pre-upgrade values survive),
//   2. post-upgrade property writes are reactive — a later `el.t = …`
//      re-renders without any manual requestUpdate,
//   3. the subclass really finalized: reactive accessors on the prototype.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// #100627: the board process must NEVER reach the live governor store.
test.use({ boardOptions: { env: { GOVERNOR_STORE_URL: "local" } } });

const ANCHOR =
	'<script type="module" src="/vendor/klh-board-register.js"></script>';

/** One wire task in the live feed shape (snake_case, loose object). */
const wireTask = (id: string): Record<string, unknown> => ({
	project: "/tmp/fleet/.git",
	id,
	title: `upgrade probe ${id}`,
	state: "READY",
	age_s: 60,
	owner_sid: null,
	execution: null,
	spend: null,
});

/** Mount markup after the last vendor script tag, keeping OR stripping the
 * register script: stripped = hosts stay UN-upgraded until we import the
 * bundle by hand (the production window where kanban markup is painted
 * while the module still loads). */
async function mount(
	page: Page,
	inner: string,
	opts: { keepRegister?: boolean } = {},
): Promise<void> {
	const keep = opts.keepRegister ?? false;
	await page.route("**/", async (route) => {
		const response = await route.fetch();
		const html = (await response.text()).replace(
			ANCHOR,
			`${keep ? ANCHOR : ""}<div id="w2672-hosts">${inner}</div>`,
		);
		await route.fulfill({ response, body: html });
	});
	// #101217: goto on a #hash URL is same-document — reload forces the
	// document request through the freshly installed route.
	await page.reload();
}

/** Upgrade the hosts by importing the served register bundle in-page. */
async function upgrade(page: Page): Promise<void> {
	await page.evaluate(async (src) => {
		await import(src);
		await customElements.whenDefined("klh-task-card-host");
	}, "/vendor/klh-board-register.js");
}

test("host assigned before upgrade renders the card once defined", {
	tag: "@ui",
}, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`); // establish origin for the route glob
	await mount(page, '<klh-task-card-host data-kid="W2672a"></klh-task-card-host>');
	// assign t BEFORE the element upgrades (kanbanSyncAll's exact write)
	await page.evaluate((t) => {
		const el = document.querySelector("klh-task-card-host");
		if (!el) throw new Error("host missing");
		el.t = t;
	}, wireTask("W2672a"));
	await upgrade(page);
	const host = page.locator('klh-task-card-host[data-kid="W2672a"]');
	await expect(host).toBeVisible();
	// THE regression: the pre-upgrade t must survive upgrade and render
	await expect(host.locator("klh-task-card .tid")).toContainText("W2672a", {
		timeout: 10_000,
	});
	await expect(host.locator(".kcard-invalid")).toHaveCount(0);
});

test("post-upgrade property writes re-render without manual requestUpdate", {
	tag: "@ui",
}, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, '<klh-task-card-host data-kid="W2672b"></klh-task-card-host>');
	await upgrade(page);
	const host = page.locator('klh-task-card-host[data-kid="W2672b"]');
	await expect(host).toBeVisible();
	// a plain property write must schedule a reactive update on its own
	await page.evaluate((t) => {
		const el = document.querySelector('klh-task-card-host[data-kid="W2672b"]');
		if (!el) throw new Error("host b missing");
		el.t = t;
	}, wireTask("W2672b"));
	await expect(host.locator("klh-task-card .tid")).toContainText("W2672b", {
		timeout: 10_000,
	});
	// and a SECOND write (the poll loop's 1Hz churn) also re-renders
	await page.evaluate((t) => {
		const el = document.querySelector('klh-task-card-host[data-kid="W2672b"]');
		if (!el) throw new Error("host b missing");
		el.t = t;
	}, { ...wireTask("W2672c"), title: "second write" });
	await expect(host.locator("klh-task-card .tid")).toContainText("W2672c", {
		timeout: 10_000,
	});
});

test("the host subclass finalized: reactive accessors on the prototype", {
	tag: "@ui",
}, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, '<klh-task-card-host data-kid="W2672d"></klh-task-card-host>');
	await upgrade(page);
	const facts = await page.evaluate(() => {
		const el = document.querySelector("klh-task-card-host");
		if (!el) throw new Error("host d missing");
		const C = el.constructor as unknown as {
			elementProperties?: Map<string, unknown>;
			prototype: object;
		};
		return {
			elementPropertiesKeys: [...(C.elementProperties?.keys() ?? [])],
			accessorT: !!Object.getOwnPropertyDescriptor(C.prototype, "t")?.set,
		};
	});
	// finalize() ran ON THE SUBCLASS: its reactive vocabulary installed
	// (the broken chunk's signature: empty map, no accessor, dead writes)
	expect(facts.elementPropertiesKeys).toContain("t");
	expect(facts.elementPropertiesKeys.length).toBeGreaterThanOrEqual(10);
	expect(facts.accessorT, "prototype accessor for t installed").toBe(true);
});
