// e2e/board-card-svg-geometry.e2e.ts — W2267.4.2.1.1: the two proof gaps
// root confirmed after the Flash-served review (B1-ns-geometry,
// B1-poll-focus). Against the REAL vendor bundle on a REAL board origin:
//   - every spend mark and attempt segment rect / artifact diamond carries
//     the SVG namespace and POSITIVE individual geometry (getBBox +
//     getBoundingClientRect) — counting rects and measuring the outer plot
//     passed while XHTML-namespace rects rendered 0x0 (root-proven defect),
//     so the children themselves are asserted here, both modes, 380/600,
//     light/dark, plus an injected XHTML-namespace control that the child
//     assertions demonstrably catch;
//   - payload refresh (the poll path) keeps the connected component, the
//     plot node identity, focus and the inspection selection while the
//     referenced bin/segment remains — and dismisses the stale inspection
//     when the payload empties or the referenced segment is gone.
import { THEME_HEAD } from "@klh/kernel/src/kernel.theme.module.ts";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SVG_NS = "http://www.w3.org/2000/svg";

// local midnight rollover: 23:50 → 01:20 next day (CET, UTC+01:00 in Nov)
const NIGHT0 = Date.UTC(2026, 10, 1, 22, 50); // 23:50 local
const SEGMENTS = [
	{ kind: "queue", start: NIGHT0, end: NIGHT0 + 5 * 60_000 },
	{ kind: "firstbyte", start: NIGHT0 + 5 * 60_000, end: NIGHT0 + 9 * 60_000 },
	{ kind: "tool", start: NIGHT0 + 9 * 60_000, end: NIGHT0 + 20 * 60_000 },
	{ kind: "pause", start: NIGHT0 + 20 * 60_000, end: NIGHT0 + 24 * 60_000 },
	{ kind: "unknown", start: NIGHT0 + 24 * 60_000, end: NIGHT0 + 34 * 60_000 },
	{ kind: "tool", start: NIGHT0 + 34 * 60_000, end: NIGHT0 + 90 * 60_000 },
] as const;

function attemptPayload(claimEnd: number | null): Record<string, unknown> {
	return {
		windowStart: NIGHT0,
		windowEnd: NIGHT0 + 90 * 60_000,
		binMs: 180_000,
		bins: 30,
		attempt: {
			sid: "autolane-1",
			index: 3,
			claimStart: NIGHT0 + 5 * 60_000,
			claimEnd,
			created: NIGHT0 - 8 * 60_000,
			firstByteAt: NIGHT0 + 9 * 60_000,
			segments: SEGMENTS.map((s) => ({ ...s })),
		},
		milestones: [
			{ ts: NIGHT0 + 30 * 60_000, commit: "deadbee", stage: "commit" },
		],
	};
}

/** the base attempt (running). */
const ATTEMPT = attemptPayload(null);

/** the poll refresh (root #102925 shape): the inspected TOOL row GROWS in
 *  place (9–20m → 9–28m — the tip must re-text to the fresh 19m duration),
 *  a second MILESTONE is inserted before it (walk index must follow the
 *  matched row, not a stale numeric slot), and the attempt index bumps
 *  3→4 (the tip's attempt line must carry the fresh index). */
const ATTEMPT_REFRESHED: Record<string, unknown> = {
	...attemptPayload(NIGHT0 + 60 * 60_000),
	attempt: {
		...(attemptPayload(NIGHT0 + 60 * 60_000).attempt as Record<
			string,
			unknown
		>),
		index: 4,
		segments: [
			{ kind: "queue", start: NIGHT0, end: NIGHT0 + 5 * 60_000 },
			{
				kind: "firstbyte",
				start: NIGHT0 + 5 * 60_000,
				end: NIGHT0 + 9 * 60_000,
			},
			{ kind: "tool", start: NIGHT0 + 9 * 60_000, end: NIGHT0 + 28 * 60_000 },
			{
				kind: "unknown",
				start: NIGHT0 + 28 * 60_000,
				end: NIGHT0 + 34 * 60_000,
			},
			{ kind: "tool", start: NIGHT0 + 34 * 60_000, end: NIGHT0 + 90 * 60_000 },
		],
	},
	milestones: [
		{ ts: NIGHT0 + 15 * 60_000, commit: "newbee1", stage: "review" },
		{ ts: NIGHT0 + 30 * 60_000, commit: "deadbee", stage: "commit" },
	],
};

/** the segment-gone refresh: pause replaced by unknown — same window, the
 *  attempt itself healthy (non-null), only the referenced row disappears. */
const ATTEMPT_NO_PAUSE: Record<string, unknown> = {
	...ATTEMPT_REFRESHED,
	attempt: {
		...(ATTEMPT_REFRESHED.attempt as Record<string, unknown>),
		segments: [
			{ kind: "queue", start: NIGHT0, end: NIGHT0 + 5 * 60_000 },
			{
				kind: "firstbyte",
				start: NIGHT0 + 5 * 60_000,
				end: NIGHT0 + 9 * 60_000,
			},
			{
				kind: "unknown",
				start: NIGHT0 + 9 * 60_000,
				end: NIGHT0 + 34 * 60_000,
			},
			{ kind: "tool", start: NIGHT0 + 34 * 60_000, end: NIGHT0 + 90 * 60_000 },
		],
	},
};

/** dense spend series: n real 3-minute bins of marks. */
function spendPoints(
	n: number,
	t0: number,
	scale = 1,
): [number, number, number, number][] {
	return Array.from({ length: n }, (_, i) => [
		t0 + i * 180_000,
		Math.round((5128 + i) * scale),
		2_094_848,
		2581,
	]);
}

const SPEND = spendPoints(21, NIGHT0);
/** the spend poll refresh (root #102929): same count, window shifted one
 *  bin forward, and NEW VALUES at every timestamp — the retained
 *  inspection must show the fresh numbers at the SAME timestamp. */
const SPEND_REFRESHED = spendPoints(21, NIGHT0 + 3 * 180_000, 10);

/** routed board-origin page mounting the real component (HTML-parser
 *  channel — same pattern as board-card-attempt-mode.spec.ts). */
async function mount(
	page: Page,
	base: string,
	theme: "dark" | "light",
	width: number,
): Promise<Locator> {
	await page.route("**/w2267-4-2-1-1-mount", (route) =>
		route.fulfill({
			contentType: "text/html; charset=utf-8",
			body:
				`<!doctype html><html data-theme="${theme}"><head>${THEME_HEAD}` +
				`<script type="module" src="/vendor/klh-board-register.js"></script>` +
				`</head><body><div style="width:${width}px">` +
				`<klh-card-activity></klh-card-activity></div></body></html>`,
		}),
	);
	await page.goto(`${base}/w2267-4-2-1-1-mount`);
	const host = page.locator("klh-card-activity");
	await expect
		.poll(() => host.evaluate((el) => el.shadowRoot !== null))
		.toBe(true);
	return host;
}

async function setProps(
	host: Locator,
	props: {
		points?: [number, number, number, number][];
		wallMs?: number | null;
		attempt?: unknown;
		mode?: string;
	},
): Promise<void> {
	await host.evaluate((el, p) => {
		const c = el as unknown as Record<string, unknown>;
		if (p.points !== undefined) c.points = p.points;
		if (p.wallMs !== undefined) c.wallMs = p.wallMs;
		if (p.attempt !== undefined) c.attempt = p.attempt;
		if (p.mode !== undefined) c.mode = p.mode;
	}, props);
}

const tipText = (host: Locator): Promise<string> =>
	host.evaluate(
		(el) => el.shadowRoot?.querySelector(".tip")?.textContent ?? "",
	);

const countIn = (host: Locator, sel: string): Promise<number> =>
	host.evaluate(
		(el, s) => el.shadowRoot?.querySelectorAll(s).length ?? -1,
		sel,
	);

/** outer plot identity — viewBox proves the measured width took hold. */
const plotOuter = (host: Locator) =>
	host.evaluate((el) => {
		const svg = el.shadowRoot?.querySelector("svg.plot");
		return {
			ns: svg?.namespaceURI ?? null,
			vb: svg?.getAttribute("viewBox") ?? "",
			h: svg?.clientHeight ?? -1,
		};
	});

interface ChildGeom {
	ns: string | null;
	bw: number;
	bh: number;
	cw: number;
	ch: number;
}

/** per-child geometry inside the shadow svg.plot: namespace + bbox + client
 *  rect for every element — the outer plot alone proves nothing (0x0 XHTML
 *  children passed the old count-only check). A child without getBBox (the
 *  XHTML-namespace defect shape) reports zeros — the defect signature. */
const childGeometry = (host: Locator, sel: string): Promise<ChildGeom[]> =>
	host.evaluate(
		(el, s) =>
			Array.from(el.shadowRoot?.querySelectorAll(s) ?? [], (n) => {
				const g = n as SVGGraphicsElement;
				const bb =
					typeof g.getBBox === "function"
						? g.getBBox()
						: { width: 0, height: 0 };
				const r = n.getBoundingClientRect();
				return {
					ns: n.namespaceURI,
					bw: bb.width,
					bh: bb.height,
					cw: r.width,
					ch: r.height,
				};
			}),
		sel,
	);

function expectAllSvg(rows: ChildGeom[], atLeast: number): void {
	expect(rows.length).toBeGreaterThanOrEqual(atLeast);
	for (const [i, r] of rows.entries()) {
		expect(r.ns, `child ${i} namespace`).toBe(SVG_NS);
		expect(r.bw, `child ${i} bbox width`).toBeGreaterThan(0);
		expect(r.bh, `child ${i} bbox height`).toBeGreaterThan(0);
		expect(r.cw, `child ${i} client width`).toBeGreaterThan(0);
		expect(r.ch, `child ${i} client height`).toBeGreaterThan(0);
	}
}

/** no foreign-namespace stray anywhere inside the plot. */
const foreignCount = (host: Locator): Promise<number> =>
	host.evaluate(
		(el, ns) =>
			Array.from(el.shadowRoot?.querySelectorAll("svg.plot *") ?? []).filter(
				(n) => n.namespaceURI !== ns,
			).length,
		SVG_NS,
	);

test("spend marks: SVG namespace + positive per-rect geometry, 380/600 × light/dark", {
	tag: "@ui",
}, async ({ page, board }) => {
	for (const theme of ["dark", "light"] as const) {
		for (const width of [380, 600]) {
			const host = await mount(page, board.BASE, theme, width);
			await setProps(host, { points: SPEND, wallMs: 9 * 3_600_000 });
			await expect
				.poll(() => countIn(host, "rect.spark-fresh"))
				.toBeGreaterThanOrEqual(10);
			const outer = await plotOuter(host);
			expect(outer.ns).toBe(SVG_NS);
			expect(outer.vb).toBe(`0 0 ${width} 40`);
			expect(outer.h).toBe(40);
			expectAllSvg(await childGeometry(host, "svg.plot rect.spark-fresh"), 10);
			expectAllSvg(await childGeometry(host, "svg.plot rect.spark-cached"), 10);
			expect(await foreignCount(host)).toBe(0);
		}
	}
});

test("attempt marks: SVG namespace + positive geometry, 380/600 × light/dark", {
	tag: "@ui",
}, async ({ page, board }) => {
	for (const theme of ["dark", "light"] as const) {
		for (const width of [380, 600]) {
			const host = await mount(page, board.BASE, theme, width);
			await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
			await expect
				.poll(() => countIn(host, "rect.at-tool"))
				.toBeGreaterThanOrEqual(2);
			const outer = await plotOuter(host);
			expect(outer.ns).toBe(SVG_NS);
			expect(outer.vb).toBe(`0 0 ${width} 40`);
			expect(outer.h).toBe(40);
			// every segment kind in the fixture renders a sized rect
			for (const kind of ["queue", "firstbyte", "tool", "pause", "unknown"])
				expectAllSvg(await childGeometry(host, `svg.plot rect.at-${kind}`), 1);
			// the artifact diamond is a PATH with positive geometry
			expectAllSvg(await childGeometry(host, "svg.plot path.at-ms"), 1);
			expect(await foreignCount(host)).toBe(0);
		}
	}
});

test("poll refresh retains node identity, focus and selection (attempt)", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(2);
	const plot = host.locator("svg.plot");
	await plot.focus();
	await expect(plot).toBeFocused();
	// keyboard-inspect: milestone → queue → firstbyte → first tool segment
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => tipText(host)).toContain("request-row minutes");
	// the poll refresh: same window, same segments, attempt progressed only.
	// Node identity via expando marker (handles compare unequal); focus via
	// shadowRoot.activeElement (document.activeElement shows the HOST while
	// focus sits inside an open shadow root — the browser's own delegation).
	await host.evaluate((el) => {
		const p = el.shadowRoot?.querySelector("svg.plot");
		if (p) (p as unknown as Record<string, unknown>).__wId = true;
	});
	await setProps(host, { attempt: ATTEMPT_REFRESHED });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(2);
	const retained = await host.evaluate((el) => {
		const p = el.shadowRoot?.querySelector("svg.plot") as
			| (SVGElement & { __wId?: boolean })
			| null;
		return {
			focused: p === el.shadowRoot?.activeElement,
			vb: p?.getAttribute("viewBox"),
			sameNode: p?.__wId === true,
		};
	});
	expect(retained.focused).toBe(true);
	expect(retained.vb).toBe("0 0 380 40");
	expect(retained.sameNode).toBe(true);
	// RETAINED + RE-TEXTED from the fresh payload (#102925): the tool row
	// grew 11m → 19m and the attempt index bumped 3 → 4 — the tip must carry
	// the FRESH values, not the stale copy.
	const tip = await tipText(host);
	expect(tip).toContain("tool · 19m");
	expect(tip).toContain("request-row minutes");
	expect(tip).toContain("attempt 4 · autolane-1");
	expect(tip).not.toContain("attempt 3");
	expect(tip).not.toContain("tool · 11m");
	// walk-follow: a milestone was inserted before the tool row — ArrowRight
	// steps to the row AFTER the matched row's fresh position (unknown),
	// proving the walk index followed the identity, not the stale slot.
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => tipText(host)).toContain("unknown");
	await expect.poll(() => tipText(host)).toContain("no fact covers this gap");
	// Escape still works after the refresh
	await page.keyboard.press("Escape");
	await expect.poll(() => tipText(host)).toBe("");
});

test("poll refresh retains node identity, focus and selection (spend)", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { points: SPEND, wallMs: 9 * 3_600_000 });
	await expect
		.poll(() => countIn(host, "rect.spark-fresh"))
		.toBeGreaterThanOrEqual(10);
	const plot = host.locator("svg.plot");
	await plot.focus();
	// select a REAL bin (W2591: 30-second adaptive slots — slot 18 is the
	// NIGHT0+9m point, which the refreshed window keeps as its FIRST bin),
	// remember its exact dual-stamped start so the refreshed tip is checked
	// against the SAME timestamp, not a slot index (#102929).
	for (let i = 0; i <= 18; i++) await page.keyboard.press("ArrowRight");
	const tipBefore = await tipText(host);
	expect(tipBefore).toContain("30-second");
	const stampLine = tipBefore.split("\n")[0] ?? "";
	if (!stampLine) throw new Error("no dual stamp on the bin tip");
	await host.evaluate((el) => {
		const p = el.shadowRoot?.querySelector("svg.plot");
		if (p) (p as unknown as Record<string, unknown>).__wId = true;
	});
	// the poll refresh: window shifts one bin forward AND every value grows
	// 10× — the retained inspection must show UPDATED numbers at the SAME
	// bin timestamp.
	await setProps(host, { points: SPEND_REFRESHED });
	await expect
		.poll(() => countIn(host, "rect.spark-fresh"))
		.toBeGreaterThanOrEqual(10);
	const retained = await host.evaluate((el) => {
		const p = el.shadowRoot?.querySelector("svg.plot") as
			| (SVGElement & { __wId?: boolean })
			| null;
		return {
			focused: p === el.shadowRoot?.activeElement,
			sameNode: p?.__wId === true,
		};
	});
	expect(retained.sameNode).toBe(true);
	expect(retained.focused).toBe(true);
	// SAME timestamp (dual-stamp line identical), UPDATED values: the
	// refreshed window starts at NIGHT0+9m and the slot-18 timestamp IS
	// that first bin — its refreshed value is 5128×10 = 51,280 (the
	// stale ~5,13x must be gone, #102929).
	const kept = await tipText(host);
	expect(kept.split("\n")[0]).toBe(stampLine);
	expect(kept).toContain("Fresh input 51,280");
	expect(kept).not.toMatch(/Fresh input 5,13\d/);
	// rollout: shift the window until the selected timestamp LEAVES it —
	// the stale inspection dismisses while node + focus remain.
	await setProps(host, { points: spendPoints(21, NIGHT0 + 12 * 180_000, 10) });
	await expect
		.poll(() =>
			host.evaluate((el) => el.shadowRoot?.querySelector(".tip") === null),
		)
		.toBe(true);
	const after = await host.evaluate((el) => {
		const p = el.shadowRoot?.querySelector("svg.plot") as
			| (SVGElement & { __wId?: boolean })
			| null;
		return {
			focused: p === el.shadowRoot?.activeElement,
			sameNode: p?.__wId === true,
		};
	});
	expect(after.sameNode).toBe(true);
	expect(after.focused).toBe(true);
});

test("stale attempt inspection dismissed when the referenced segment is gone", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect.poll(() => countIn(host, "rect.at-pause")).toBe(1);
	const plot = host.locator("svg.plot");
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	// hover the pause segment (20–24m of the 90m window ≈ 0.244)
	await page.mouse.move(box.x + box.width * 0.244, box.y + 20);
	await expect.poll(() => tipText(host)).toContain("pause");
	// the refresh removes pause — the tip must not survive its source
	await setProps(host, { attempt: ATTEMPT_NO_PAUSE });
	await expect.poll(() => countIn(host, "rect.at-pause")).toBe(0);
	await expect
		.poll(() =>
			host.evaluate((el) => el.shadowRoot?.querySelector(".tip") === null),
		)
		.toBe(true);
});

test("negative control: the child assertions catch an injected XHTML-namespace 0x0 rect", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { points: SPEND, wallMs: 9 * 3_600_000 });
	await expect
		.poll(() => countIn(host, "rect.spark-fresh"))
		.toBeGreaterThanOrEqual(10);
	// recreate the ORIGINAL defect shape inside the real plot: an element
	// minted through the HTML parser channel (XHTML namespace, 0x0 bbox —
	// exactly what html`` templates produced inside svg`` parents)
	await host.evaluate((el) => {
		const svg = el.shadowRoot?.querySelector("svg.plot");
		if (!svg) throw new Error("plot missing");
		const doc = new DOMParser().parseFromString(
			'<rect class="spark-fresh"></rect>',
			"text/html",
		);
		const stray = doc.body.firstElementChild;
		if (!stray) throw new Error("injection failed");
		svg.appendChild(stray);
	});
	// the geometry walk must SEE the stray and report it as the defect it is
	const rows = await childGeometry(host, "svg.plot rect.spark-fresh");
	const stray = rows.filter(
		(r) => r.ns !== SVG_NS || r.bw <= 0 || r.bh <= 0 || r.cw <= 0 || r.ch <= 0,
	);
	expect(stray.length).toBe(1);
	expect(stray[0]?.ns).not.toBe(SVG_NS);
});
