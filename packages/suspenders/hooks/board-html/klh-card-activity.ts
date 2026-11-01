// hooks/board-html/klh-card-activity.ts — W2267.2: the board card's
// spectral activity plot + duration hairline, one focused Lit component.
// Data truth is the pure lib (hooks/lib/board/activity-scale.ts — W1203
// measured-width, end-pinned, REAL 3-minute bins); this file renders what
// those helpers compute. The card lane (W2267.4) wires spendSeries points
// + spend.wall_ms (+ attemptData, a W1188 passthrough) into it through the
// typed contract (hooks/lib/board/activity-contract.ts).
//
// Layout law (owner contract 2026-10-29, "tight time rail"): the hairline
// is exactly 1 CSS px tall with ZERO own margin/padding, flush against the
// plot's bottom edge; the axis is one ~10px/12px line beneath; elapsed
// wall time grows symmetrically from the midpoint on ONE shared 24h scale
// — never a progress bar, zero/unknown draws nothing, overflow saturates
// and says so.
import { css, html, LitElement, type TemplateResult } from "lit";
import {
	ACTIVITY_BAR_PX,
	durationSpan,
	fmtDurationExact,
	fmtScaleLabel,
	spectralBins,
	type SpectralBins,
} from "../lib/board/activity-scale.ts";
import { dualShort, dualStamp } from "../lib/wallclock.ts";

class KlhCardActivity extends LitElement {
	static properties = {
		points: { attribute: false },
		wallMs: { attribute: false },
		attempt: { attribute: false },
		_tip: { state: true },
		_slot: { state: true },
	};
	declare points: [number, number, number, number][];
	declare wallMs: number | null;
	/** AttemptTimeline passthrough (W1188) — the card lane owns the view. */
	declare attempt: unknown | null;
	/** tooltip text (null = hidden). */
	declare _tip: string | null;
	/** keyboard-focused bin index (-1 = none). */
	declare _slot: number;

	static styles = css`
		:host {
			display: block;
			font: 11px/1.5 ui-sans-serif, system-ui;
		}
		.plot {
			display: block;
			width: 100%;
			height: 28px;
		}
		.plot:focus-visible {
			outline: 2px solid var(--klh-accent, #d8900f);
			outline-offset: 1px;
		}
		.plot rect.spark-fresh {
			fill: var(--klh-accent, #d8900f);
		}
		.plot rect.spark-cached {
			fill: var(--klh-ok, #5c7a35);
		}
		.axis {
			display: flex;
			justify-content: space-between;
			gap: 8px;
			margin: 0;
			padding: 0;
			font: 400 10px/12px ui-monospace, SFMono-Regular, monospace;
			color: var(--klh-chart-axis, #898781);
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
			overflow: hidden;
		}
		/* the duration hairline: exactly 1 CSS px, zero own margin/padding,
		   flush under the plot's bottom edge (owner tight-rail contract). */
		.hairline {
			display: block;
			height: 1px;
			margin: 0;
			padding: 0;
			background: transparent;
			position: relative;
		}
		.hairline .span {
			position: absolute;
			top: 0;
			bottom: 0;
			background: var(--klh-accent, #d8900f);
		}
		.hairline.saturated .span {
			background: var(--klh-danger, #af2f12);
		}
		.tip {
			position: fixed;
			z-index: 1000;
			max-width: 260px;
			padding: 6px 8px;
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 6px;
			background: var(--klh-surface, #1c1b19);
			color: var(--klh-ink, #e8e6e1);
			font: 11px/1.5 ui-monospace, SFMono-Regular, monospace;
			white-space: pre-line;
			pointer-events: none;
		}
	`;

	constructor() {
		super();
		this.points = [];
		this.wallMs = null;
		this.attempt = null;
		this._tip = null;
		this._slot = -1;
	}

	// the measured track (W1203): recompute on width change.
	private _ro: ResizeObserver | null = null;
	private _width = 0;

	connectedCallback(): void {
		super.connectedCallback();
		if (typeof ResizeObserver !== "undefined") {
			this._ro = new ResizeObserver(() => {
				const w = this._plotEl()?.clientWidth ?? 0;
				if (w !== this._width) {
					this._width = w;
					this.requestUpdate();
				}
			});
		}
	}

	disconnectedCallback(): void {
		this._ro?.disconnect();
		this._ro = null;
		super.disconnectedCallback();
	}

	protected firstUpdated(): void {
		const el = this._plotEl();
		if (el && this._ro) {
			this._width = el.clientWidth;
			this._ro.observe(el);
		}
	}

	private _plotEl(): SVGSVGElement | null {
		return this.renderRoot.querySelector("svg.plot");
	}

	/** the window derives from the MEASURED track (W1203) — recomputed on
	 *  width/data change; the floor keeps the first paint non-degenerate. */
	private get _spec(): SpectralBins {
		return spectralBins(this.points, this._width || 240);
	}

	/** pointer → exact bin; empty bins hover too (honest "no requests"). */
	private _hover = (e: PointerEvent): void => {
		const svgEl = this._plotEl();
		const spec = this._spec;
		if (!svgEl || !spec.hasData) {
			this._hideTip();
			return;
		}
		const r = svgEl.getBoundingClientRect();
		if (r.width === 0) return;
		const slot = Math.max(
			0,
			Math.min(
				spec.count - 1,
				Math.floor(((e.clientX - r.left) / r.width) * spec.count),
			),
		);
		this._slot = slot;
		this._tip = this._tipText(spec, slot);
		this.requestUpdate();
		this._placeTip(e.clientX, e.clientY);
	};

	private _hide = (): void => {
		this._hideTip();
		this.requestUpdate();
	};

	/** keyboard: ←/→ walk REAL bins (empty bins too), Esc hides. */
	private _keyNav = (e: KeyboardEvent): void => {
		const spec = this._spec;
		if (e.key === "Escape") {
			this._hide();
			return;
		}
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const dir = e.key === "ArrowLeft" ? -1 : 1;
		const slot = Math.max(0, Math.min(spec.count - 1, this._slot + dir));
		this._slot = slot;
		this._tip = this._tipText(spec, slot);
		this.requestUpdate();
		const svgEl = this._plotEl();
		if (svgEl) {
			const r = svgEl.getBoundingClientRect();
			this._placeTip(r.left + ((slot + 0.5) / spec.count) * r.width, r.top + 8);
		}
	};

	private _hideTip(): void {
		this._tip = null;
		this._slot = -1;
	}

	/** exact tooltip text for one bin (W902 dual stamps, exact counts). */
	private _tipText(spec: SpectralBins, slot: number): string {
		const b = spec.bins[slot];
		const t0 = (spec.windowStart ?? 0) + slot * spec.slotMs;
		const t1 = t0 + spec.slotMs;
		const lines = [
			dualStamp(t0),
			`bin ${spec.slotMs / 60000} min · ${dualShort(t0)} → ${dualShort(t1)}`,
		];
		if (b) {
			lines.push(`Fresh input ${b.fresh.toLocaleString("en-US")}`);
			lines.push(`Cached input ${b.cached.toLocaleString("en-US")}`);
			lines.push(`Output ${b.out.toLocaleString("en-US")}`);
		} else {
			lines.push("no requests in this bin");
		}
		return lines.join("\n");
	}

	/** REAL bins only: stacked fresh-over-cached rects, max-normalized
	 *  within the visible window. */
	private _barsSvg(spec: SpectralBins): TemplateResult {
		const w = this._width || 240;
		const step = w / spec.count;
		let maxV = 0;
		for (const b of spec.bins) if (b) maxV = Math.max(maxV, b.fresh + b.cached);
		const bars: TemplateResult[] = [];
		if (maxV > 0)
			for (let i = 0; i < spec.count; i++) {
				const b = spec.bins[i];
				if (!b) continue;
				const x = i * step + (step - ACTIVITY_BAR_PX) / 2;
				bars.push(this._barRects(b, x, maxV));
			}
		return html`${bars}`;
	}

	/** fresh stacked over cached, sparkSvg parity: 0.5px floor, 1px inset. */
	private _barRects(
		b: { fresh: number; cached: number },
		x: number,
		maxV: number,
	): TemplateResult {
		const h = 28;
		const parts: TemplateResult[] = [];
		let used = 0;
		const stack: [number, string][] = [
			[b.fresh, "spark-fresh"],
			[b.cached, "spark-cached"],
		];
		for (const [val, cls] of stack) {
			if (val <= 0) continue;
			const bh = Math.max(0.5, (val / maxV) * (h - 2));
			parts.push(
				html`<rect
					class=${cls}
					x=${x.toFixed(1)}
					y=${Math.max(1, h - 1 - used - bh).toFixed(1)}
					width=${ACTIVITY_BAR_PX}
					height=${bh.toFixed(1)}
				/>`,
			);
			used += bh;
		}
		return html`${parts}`;
	}

	/** the 1-CSS-px duration hairline: elapsed wall time on the ONE shared
	 *  scale, center-out; zero/unknown → nothing rendered at all. */
	private _hairlineHtml(): TemplateResult | null {
		const w = this._width || 240;
		const span = durationSpan(this.wallMs, w);
		if (!span.visible) return null;
		return html`<div
			class="hairline${span.saturated ? " saturated" : ""}"
			role="img"
			aria-label="elapsed ${fmtDurationExact(this.wallMs ?? 0)} of ${fmtScaleLabel()} scale${span.saturated ? " — saturated at full width" : ""}"
			title="elapsed ${fmtDurationExact(this.wallMs ?? 0)} of ${fmtScaleLabel()} scale${span.saturated ? " — saturated at full width" : ""}"
		>
			<span
				class="span"
				style="left:${span.start.toFixed(1)}px;width:${(span.end - span.start).toFixed(1)}px"
			></span>
		</div>`;
	}

	/** the one-line axis: visible window start | TZ + bin width | window
	 *  end — the ACTUAL window, never the first-ever request. */
	private _axisHtml(spec: SpectralBins): TemplateResult {
		const tz = this._tzLabel();
		return html`<div class="axis">
			<span>${spec.hasData ? dualShort(spec.windowStart ?? 0) : ""}</span>
			<span
				>${
					spec.hasData ? `${tz} · ${spec.slotMs / 60000}m/bin` : "no activity"
				}</span
			>
			<span>${spec.hasData ? dualShort(spec.windowEnd ?? 0) : ""}</span>
		</div>`;
	}

	/** the browser's own offset label: "UTC+02:00" — one shared format. */
	private _tzLabel(): string {
		const off = -new Date().getTimezoneOffset();
		const a = Math.abs(off);
		const sign = off >= 0 ? "+" : "-";
		return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
	}

	/** the tooltip: exact values, viewport-clamped by _placeTip. */
	private _tipHtml(): TemplateResult {
		return html`<div class="tip" role="tooltip">${this._tip}</div>`;
	}

	/** viewport-safe placement: right of the cursor, flip above when tight. */
	private _placeTip(x: number, y: number): void {
		const tip = this.renderRoot.querySelector<HTMLElement>(".tip");
		if (!tip) return;
		const left = Math.min(x + 10, window.innerWidth - tip.offsetWidth - 8);
		const above = y - tip.offsetHeight - 10;
		tip.style.left = `${Math.max(8, left)}px`;
		tip.style.top = `${above >= 8 ? above : y + 12}px`;
	}

	protected render() {
		const spec = this._spec;
		return html`
			<svg
				class="plot"
				viewBox="0 0 ${this._width || 240} 28"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${spec.slotMs / 60000}-minute bins across the measured track"
				tabindex="0"
				@pointermove=${this._hover}
				@pointerleave=${this._hide}
				@keydown=${this._keyNav}
			>
				${this._barsSvg(spec)}
			</svg>
			${this._hairlineHtml()}
			${this._axisHtml(spec)}
			${this._tip ? this._tipHtml() : null}
		`;
	}
}

customElements.define("klh-card-activity", KlhCardActivity);
