// e2e/spark-geom.ts — W1203: measured-width geometry probe for the board
// sparklines: the svg's rendered bars vs its track, plus the axis label the
// chunk derives from the actual window, read inside the page under test.
// W2267.4.2.2 adds StripGeom: the same measured-track law for the ONE Lit
// strip (klh-card-activity) — its viewBox width IS its measured client
// width, so viewBox units are CSS px and the W1203 invariants carry over.
import type { Page } from "@playwright/test";

export type SparkGeom = {
	trackW: number;
	svgW: number;
	spanW: number;
	barCount: number;
	firstLeft: number;
	lastRight: number;
	barWidths: number[];
	axisLabel: string;
	axisExpected: string;
};

export type StripGeom = {
	trackW: number;
	viewBoxW: number;
	barCount: number;
	firstLeft: number;
	lastRight: number;
	barWidths: number[];
};

export const measureSpark = (page: Page, scope: string): Promise<SparkGeom> =>
	page.evaluate((sel) => {
		const root = document.querySelector(sel) ?? document;
		const plot = root.querySelector(".ksparkplot");
		const spark = plot?.querySelector(".kspark");
		const svg = plot?.querySelector("svg");
		const track = plot?.getBoundingClientRect().width ?? 0;
		const box = svg?.getBoundingClientRect().width ?? 0;
		const rectEls = [...(svg?.querySelectorAll("rect") ?? [])];
		const boxes = rectEls.map((r) => r.getBoundingClientRect());
		const binMin = svg?.getAttribute("data-bin-min") ?? "";
		const windowEnd = Number(svg?.getAttribute("data-window-end") ?? 0);
		// the axis rides the board's shared dual-stamp embed (W1107.1.2)
		const fmt = (ms: number) =>
			(window as unknown as { dualShort: (v: number) => string }).dualShort(ms);
		return {
			trackW: track,
			svgW: box,
			spanW: spark instanceof HTMLElement ? spark.clientWidth : 0,
			barCount: new Set(rectEls.map((r) => r.getAttribute("data-at") ?? ""))
				.size,
			firstLeft: boxes.length > 0 ? boxes[0].left - rectLeft() : -1,
			lastRight:
				boxes.length > 0 ? boxes[boxes.length - 1].right - rectLeft() : -1,
			barWidths: boxes.map((b) => b.width),
			axisLabel:
				plot?.querySelector(".ksparkaxis span:last-child")?.textContent ?? "",
			axisExpected: `${fmt(windowEnd)} · ${binMin} bins`,
		};
		function rectLeft(): number {
			return (
				document.querySelector(`${sel} .ksparkplot`)?.getBoundingClientRect()
					.left ?? 0
			);
		}
	}, scope);

/** The Lit strip's measured geometry (W2267.4.2.2): bars vs the svg.plot
 *  track it measured itself — one card selector in, one StripGeom out. */
export const measureStrip = (page: Page, scope: string): Promise<StripGeom> =>
	page.evaluate((sel) => {
		const card = document.querySelector(sel);
		const strip =
			card?.querySelector("klh-card-activity") ??
			card?.shadowRoot?.querySelector("klh-card-activity") ??
			null;
		const svg = strip?.shadowRoot?.querySelector("svg.plot") ?? null;
		const viewBox = (svg?.getAttribute("viewBox") ?? "").split(/\s+/);
		const rectEls = [...(svg?.querySelectorAll("rect") ?? [])];
		const xs = rectEls.map((r) => Number(r.getAttribute("x")));
		const uniq = [...new Set(xs)].sort((a, b) => a - b);
		const lefts = rectEls.map((r) => r.getBoundingClientRect().left);
		const rights = rectEls.map((r) => r.getBoundingClientRect().right);
		const trackLeft = svg?.getBoundingClientRect().left ?? 0;
		return {
			trackW: svg?.getBoundingClientRect().width ?? 0,
			viewBoxW: Number(viewBox[2] ?? 0),
			barCount: uniq.length,
			firstLeft: lefts.length > 0 ? Math.min(...lefts) - trackLeft : Number.NaN,
			lastRight:
				rights.length > 0 ? Math.max(...rights) - trackLeft : Number.NaN,
			barWidths: rectEls.map((r) => r.getBoundingClientRect().width),
		};
	}, scope);
