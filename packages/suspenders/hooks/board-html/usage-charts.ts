// hooks/board-html/usage-charts.ts — <klh-usage-charts>, moved verbatim from
// usage-panels.ts in the W1298 decomposition: the uPlot panels (stacked
// timeline + hour histogram), light DOM by exception.
import { css, html, LitElement, type TemplateResult } from "lit";
import {
	fmtChartValue,
	fmtTok,
	readPayload,
	slotColor,
} from "./usage-shared.ts";

// ─── <klh-usage-charts> — the uPlot panels (timeline + hour histogram) ─────
// Light DOM by exception: uPlot builds its own canvas DOM inside the mount
// divs and the document-level uPlot chrome CSS must reach it —
// createRenderRoot returns the element itself. Absorbs the retired
// bin/usage-charts.ts: one host, no inline render script on the page.
// Titles ride the tl/hours attributes (the fed page passes its own).
interface UPlotChart {
	width: number;
	redraw(resetScales: boolean, recreate: boolean): void;
	setSize(size: { width: number; height: number }): void;
}
interface UPlotCtor {
	new (
		opts: Record<string, unknown>,
		data: unknown[][],
		target: HTMLElement,
	): UPlotChart;
	paths?: { bars(opts: { size: [number, number] }): unknown };
}

export class KlhUsageCharts extends LitElement {
	static properties = {
		tl: { type: String },
		hours: { type: String },
	};

	declare tl: string;
	declare hours: string;
	private slot: Record<string, string> = {};
	private groups: string[] = [];
	private timeline: number[][] = [];
	private byHour: number[][] = [];
	private charts: UPlotChart[] = [];
	private ros: ResizeObserver[] = [];
	private resizes: (() => void)[] = [];
	private onTheme: (() => void) | null = null;

	constructor() {
		super();
		this.tl = "TOKENS · STACKED BY MODEL GROUP";
		this.hours = "WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)";
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.tl = this.getAttribute("tl") ?? this.tl;
		this.hours = this.getAttribute("hours") ?? this.hours;
		const root = readPayload();
		this.slot = root?.slot ?? {};
		this.groups = root?.groups ?? [];
		this.timeline = root?.timeline ?? [];
		this.byHour = root?.byHour ?? [];
		if (this.onTheme === null) {
			this.onTheme = () => {
				for (const c of this.charts) c.redraw(false, true);
			};
			document.addEventListener("klh-themechange", this.onTheme);
		}
	}

	protected disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const ro of this.ros) ro.disconnect();
		this.ros = [];
		for (const fn of this.resizes) window.removeEventListener("resize", fn);
		this.resizes = [];
		if (this.onTheme !== null) {
			document.removeEventListener("klh-themechange", this.onTheme);
			this.onTheme = null;
		}
	}

	// uPlot paints into the light-DOM mount divs — see the block comment
	protected createRenderRoot(): HTMLElement {
		return this;
	}

	protected render(): TemplateResult {
		if (!this.timeline.length && !this.byHour.length) return html``;
		return html`<div class="usage-chart-grid"><div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map(
						(g) =>
							html`<span><i style=${`background:${slotColor(this.slot, g)}`}></i
								>${g}</span>`,
					)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div></div>`;
	}

	protected firstUpdated(): void {
		const uPlot = (globalThis as { uPlot?: UPlotCtor }).uPlot;
		if (!uPlot) return; // vendor inline absent — degrade honestly
		// chart chrome follows the klh theme tokens; uPlot calls the stroke fns
		// on every draw, so a klh-themechange only needs a redraw (W269)
		const tok = (name: string, dflt: string): string => {
			const v = getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim();
			return v || dflt;
		};
		const grid = (): string => tok("--klh-chart-grid", "#2c2c2a");
		const hair = (): string => tok("--klh-chart-hair", "#383835");
		const axis = (): string => tok("--klh-chart-axis", "#898781");
		const yVals = (_u: unknown, splits: number[]): string[] =>
			splits.map((v) => fmtTok(v));
		const mkAxis = (
			side: number,
			values?: (u: unknown, splits: number[]) => string[],
		): Record<string, unknown> => {
			const a: Record<string, unknown> = {
				side,
				// The default left gutter clips the leading digit at 100M+.
				...(side === 3 ? { size: 72 } : {}),
				stroke: axis,
				grid: { show: true, stroke: grid, width: 1 },
				ticks: { show: true, stroke: hair, width: 1 },
			};
			if (values) a.values = values;
			return a;
		};
		const tEl = this.querySelector<HTMLElement>("#u-timeline");
		if (tEl && this.groups.length) {
			// series order IS the fixed group order, so a group keeps its color
			// everywhere it appears on the page
			const series: Record<string, unknown>[] = [{}];
			for (const g of this.groups) {
				const c = slotColor(this.slot, g);
				series.push({
					label: g,
					stacked: true,
					stroke: c,
					fill: c,
					width: 1,
					points: { show: false },
					value: (_u: unknown, v: number | null): string => fmtChartValue(v),
				});
			}
			this.chart(
				tEl,
				uPlot,
				{
					width: tEl.clientWidth,
					height: 300,
					legend: { show: true, live: true },
					scales: { x: { time: true } },
					series,
					axes: [mkAxis(2), mkAxis(3, yVals)],
				},
				this.timeline,
				300,
			);
		}
		// hour-of-day histogram — single-series distribution, slot 1 (flash blue)
		const hEl = this.querySelector<HTMLElement>("#u-hours");
		if (hEl) {
			this.chart(
				hEl,
				uPlot,
				{
					width: hEl.clientWidth,
					height: 190,
					legend: { show: false },
					scales: { x: { time: false } },
					series: [
						{},
						{
							label: "tokens",
							stroke: slotColor(this.slot, "flash"),
							fill: slotColor(this.slot, "flash"),
							paths: uPlot.paths?.bars({ size: [0.72, 100] }),
							points: { show: false },
							value: (_u: unknown, v: number | null): string =>
								fmtChartValue(v),
						},
					],
					axes: [
						mkAxis(2, (_u, splits) =>
							splits.map((v) => String(Math.round(v)).padStart(2, "0")),
						),
						mkAxis(3, yVals),
					],
				},
				this.byHour,
				190,
			);
		}
	}

	private chart(
		el: HTMLElement,
		uPlot: UPlotCtor,
		opts: Record<string, unknown>,
		data: unknown[][],
		height: number,
	): void {
		const u = new uPlot(opts, data, el);
		this.charts.push(u);
		const fit = (): void => {
			const w = el.clientWidth;
			if (w > 0 && w !== u.width) u.setSize({ width: w, height });
		};
		if (typeof ResizeObserver === "function") {
			const ro = new ResizeObserver(fit);
			ro.observe(el);
			this.ros.push(ro);
		} else {
			this.resizes.push(fit);
			window.addEventListener("resize", fit);
		}
	}
}

KlhUsageCharts.styles = css`
	:host {
		display: block;
	}
`;
