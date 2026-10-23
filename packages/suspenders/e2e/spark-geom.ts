// e2e/spark-geom.ts — W1203: measured-width geometry probe for the board
// sparklines: the svg's rendered bars vs its track, plus the axis label the
// chunk derives from the actual window, read inside the page under test.
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
		const fmt = (ms: number) =>
			new Date(ms).toLocaleTimeString("da-DK", {
				hour: "2-digit",
				minute: "2-digit",
			});
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
			axisExpected: `${fmt(windowEnd)} · ${binMin}m/bin`,
		};
		function rectLeft(): number {
			return (
				document.querySelector(`${sel} .ksparkplot`)?.getBoundingClientRect()
					.left ?? 0
			);
		}
	}, scope);
