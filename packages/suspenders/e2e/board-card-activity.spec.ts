// e2e/board-card-activity.spec.ts — W2267.2: the card activity component
// (<klh-card-activity>) against the REAL vendor bundle served by a REAL
// board: centered endpoints at multiple durations, the computed 1px
// hairline with zero own margin/padding, both themes, and the tooltip in
// viewport. The card lane (W2267.4) mounts it in the kanban card; this
// spec mounts it on a board-origin routed page (same-origin module load,
// HTML-parser channel — UI-law clean) with the theme head inlined from
// the lib; the component under test is the real built artifact, no
// reimplementation.

import { THEME_HEAD } from "@klh/kernel/src/kernel.theme.module.ts";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const T0 = 1_700_000_000_000;
const PTS: [number, number, number, number][] = [
	[T0, 5128, 2_094_848, 2581],
	[T0 + 180_000, 5000, 2_000_000, 2000],
	[T0 + 360_000, 4000, 1_000_000, 1500],
];

/** one mounted component page: the real board origin (same-origin module
 *  load), HTML delivered by the page's own parser via a routed stub. */
async function mountActivity(
	page: Page,
	base: string,
	points: [number, number, number, number][],
	wallMs: number | null,
	theme: "dark" | "light",
	premount = false,
): Promise<void> {
	await page.route("**/w2267-2-mount", (route) =>
		route.fulfill({
			contentType: "text/html; charset=utf-8",
			body:
				`<!doctype html><html data-theme="${theme}"><head>${THEME_HEAD}` +
				`<script type="module" src="/vendor/klh-card-activity.js"></script>` +
				`</head><body><klh-card-activity style="width:360px"></klh-card-activity></body></html>`,
		}),
	);
	if (premount) await preMount(page, points, wallMs);
	await page.goto(`${base}/w2267-2-mount`);
	const host = page.locator("klh-card-activity").last();
	await expect
		.poll(() => host.evaluate((el) => el.shadowRoot !== null))
		.toBe(true);
	if (!premount) await setProps(host, points, wallMs);
}

/** B1 (W2514): set element data pre-upgrade (post-upgrade poke re-renders
 *  and masks the first-paint bug). */
async function preMount(
	page: Page,
	points: [number, number, number, number][],
	wallMs: number | null,
): Promise<void> {
	await page.addInitScript(applyOnDefine, [points, wallMs]);
}

/** runs in the page: wrap customElements.define so the stub's element —
 *  already parsed when the module executes — receives the data just
 *  before upgrade; Lit stashes own props and replays them in the first
 *  performUpdate. */
const applyOnDefine = (data: unknown) => {
	const [pts, wall] = data as [
		[number, number, number, number][],
		number | null,
	];
	const c = customElements;
	const apply = (el: Element) => {
		const o = el as unknown as Record<string, unknown>;
		o.points = pts;
		o.wallMs = wall;
	};
	const define = c.define.bind(c);
	c.define = ((name, ctor, opts) => {
		if (name === "klh-card-activity")
			for (const el of document.querySelectorAll(name)) {
				const known = c.get(name);
				if (!known || !(el instanceof known)) apply(el);
			}
		return define(name, ctor, opts);
	}) as typeof c.define;
};

async function setProps(
	host: Locator,
	points: [number, number, number, number][],
	wallMs: number | null,
): Promise<void> {
	await host.evaluate(
		(el, [pts, wall]) => {
			const c = el as unknown as Record<string, unknown>;
			c.points = pts;
			c.wallMs = wall;
		},
		[points, wallMs] as [[number, number, number, number][], number | null],
	);
}

/** hairline + plot geometry from the component's shadow root. */
const geom = (page: Page) =>
	page.locator("klh-card-activity").evaluate((el) => {
		const root = el.shadowRoot;
		const line = root?.querySelector<HTMLElement>(".hairline");
		const span = root?.querySelector<HTMLElement>(".hairline .span");
		const plot = root?.querySelector<HTMLElement>(".plot");
		const cs = line ? getComputedStyle(line) : null;
		const spanCs = span ? getComputedStyle(span) : null;
		return {
			lineH: line?.getBoundingClientRect().height ?? -1,
			marginTop: cs ? Number.parseFloat(cs.marginTop) : -1,
			marginBottom: cs ? Number.parseFloat(cs.marginBottom) : -1,
			padTop: cs ? Number.parseFloat(cs.paddingTop) : -1,
			padBottom: cs ? Number.parseFloat(cs.paddingBottom) : -1,
			spanLeft: spanCs ? Number.parseFloat(spanCs.left) : -1,
			spanWidth: spanCs ? Number.parseFloat(spanCs.width) : -1,
			plotBottom: plot?.getBoundingClientRect().bottom ?? -1,
			lineTop: line?.getBoundingClientRect().top ?? -1,
		};
	});

test("hairline: 1px, zero own margin/padding, flush, centered per duration", {
	tag: "@ui",
}, async ({ page, board }) => {
	// half the 24h scale on a 360px card → 180px span starting at 90px
	await mountActivity(page, board.BASE, PTS, 12 * 3_600_000, "dark");
	await expect.poll(async () => (await geom(page)).lineH).toBe(1);
	const g = await geom(page);
	expect(g.marginTop).toBe(0);
	expect(g.marginBottom).toBe(0);
	expect(g.padTop).toBe(0);
	expect(g.padBottom).toBe(0);
	expect(Math.abs(g.lineTop - g.plotBottom)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(g.spanLeft - 90)).toBeLessThanOrEqual(1.5);
	expect(Math.abs(g.spanWidth - 180)).toBeLessThanOrEqual(1.5);
});

test("hairline: quarter scale, saturation, zero/unknown all honest", {
	tag: "@ui",
}, async ({ page, board }) => {
	// 6h = quarter of the 24h scale → 90px span starting at 135px
	await mountActivity(page, board.BASE, PTS, 6 * 3_600_000, "dark");
	await expect
		.poll(async () => (await geom(page)).spanWidth)
		.toBeCloseTo(90, 0);
	const q = await geom(page);
	expect(Math.abs(q.spanLeft - 135)).toBeLessThanOrEqual(1.5);
	// saturation: 48h pins the full 360px and says so
	await mountActivity(page, board.BASE, PTS, 48 * 3_600_000, "dark");
	await expect
		.poll(async () => (await geom(page)).spanWidth)
		.toBeCloseTo(360, 0);
	const sat = await page
		.locator("klh-card-activity .hairline")
		.evaluate((el) => el.getAttribute("aria-label") ?? "");
	expect(sat).toContain("saturated");
	// zero/unknown duration → no hairline element at all
	await mountActivity(page, board.BASE, PTS, 0, "dark");
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate((el) => el.shadowRoot?.querySelector(".hairline") === null),
		)
		.toBe(true);
});

test("themes: axis + hairline paint in both themes without console errors", {
	tag: "@ui",
}, async ({ page, board }) => {
	for (const theme of ["dark", "light"] as const) {
		await mountActivity(page, board.BASE, PTS, 9 * 3_600_000, theme);
		await expect.poll(async () => (await geom(page)).lineH).toBe(1);
		const axis = await page
			.locator("klh-card-activity")
			.evaluate(
				(el) =>
					el.shadowRoot?.querySelector(".axis")?.textContent?.trim() ?? "",
			);
		expect(axis).toContain("m/bin");
		expect(axis).toContain("UTC");
	}
});

test("tooltip: exact bin values, keyboard reachable, stays in viewport", {
	tag: "@ui",
}, async ({ page, board }) => {
	await mountActivity(page, board.BASE, PTS, 9 * 3_600_000, "dark");
	const plot = page.locator("klh-card-activity .plot");
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	await page.mouse.move(box.x + 4, box.y + 14);
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate(
					(el) => el.shadowRoot?.querySelector(".tip")?.textContent ?? "",
				),
		)
		.toContain("Fresh input 5,128");
	const tipBox = await page.locator("klh-card-activity").evaluate((el) => {
		const t = el.shadowRoot?.querySelector<HTMLElement>(".tip");
		return t?.getBoundingClientRect().toJSON();
	});
	expect(tipBox).toBeTruthy();
	expect(tipBox?.left ?? -1).toBeGreaterThanOrEqual(0);
	expect(tipBox?.right ?? 9999).toBeLessThanOrEqual(1280);
	// keyboard: focus the plot, ArrowRight walks bins, Esc hides
	await plot.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate(
					(el) => el.shadowRoot?.querySelector(".tip")?.textContent ?? "",
				),
		)
		.toContain("3 min");
	await page.keyboard.press("Escape");
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate((el) => el.shadowRoot?.querySelector(".tip") === null),
		)
		.toBe(true);
});

test("first paint uses the measured width, not the 240px floor (W2514 B1)", {
	tag: "@ui",
}, async ({ page, board }) => {
	// data lands pre-upgrade: the FIRST render after upgrade must already
	// carry the measured 360px track. Buggy: firstUpdated set _width with no
	// re-render and the RO's first callback sees w === _width → the card
	// renders at the 240px fallback forever.
	await mountActivity(page, board.BASE, PTS, 9 * 3_600_000, "dark", true);
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate(
					(el) =>
						el.shadowRoot?.querySelector("svg.plot")?.getAttribute("viewBox") ??
						"",
				),
		)
		.toBe("0 0 360 28");
});

test("hairline duration/scale is keyboard exposed (W2514 B2)", {
	tag: "@ui",
}, async ({ page, board }) => {
	await mountActivity(page, board.BASE, PTS, 9 * 3_600_000, "dark");
	const plot = page.locator("klh-card-activity .plot");
	const line = page.locator("klh-card-activity .hairline");
	await plot.focus();
	await page.keyboard.press("Tab");
	// locators pierce the open shadow root; toBeFocused walks it
	await expect(line).toBeFocused();
	const tip = () =>
		page
			.locator("klh-card-activity")
			.evaluate(
				(el) => el.shadowRoot?.querySelector(".tip")?.textContent ?? "",
			);
	await expect.poll(tip).toContain("9h 00m");
	await expect.poll(tip).toContain("24h scale");
	await page.keyboard.press("Escape");
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate((el) => el.shadowRoot?.querySelector(".tip") === null),
		)
		.toBe(true);
	// zero duration → no hairline at all → nothing extra to focus
	await mountActivity(page, board.BASE, PTS, 0, "dark", true);
	await expect
		.poll(() =>
			page
				.locator("klh-card-activity")
				.evaluate((el) => el.shadowRoot?.querySelector(".hairline") === null),
		)
		.toBe(true);
});
