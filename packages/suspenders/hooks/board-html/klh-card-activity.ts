// hooks/board-html/klh-card-activity.ts — W2267.2/W2267.4.2.1: the board
// card's ONE activity strip — spectral spend plot + attempt timeline, one
// focused Lit component switching contents in place (never a second chart).
// Data truth is the pure lib (hooks/lib/board/activity-scale.ts — W1203
// measured-width, end-pinned, REAL 3-minute bins, W2267.4.2.1 ONE honest
// plotted=labeled=inspectable domain); this file renders what those helpers
// compute. The card lane (W2267.4) wires spendSeries points + spend.wall_ms
// + attemptData into it through the typed contract (hooks/lib/board/
// activity-contract.ts). SVG children ride svg`` templates — html`` would
// mint XHTML-namespace rects with 0x0 bbox (root-proven W2267.4.2.1).
//
// Layout law (owner contract 2026-10-29, "tight time rail"): the hairline
// is exactly 1 CSS px tall with ZERO own margin/padding, flush against the
// plot's bottom edge; the axis is one ~10px/12px line beneath; elapsed
// wall time grows symmetrically from the midpoint on ONE shared 24h scale
// — never a progress bar, zero/unknown draws nothing, overflow saturates
// and says so.
import { css, html, LitElement, svg, type TemplateResult } from "lit";
import {
	ACTIVITY_BAR_PX,
	durationSpan,
	fmtDurationExact,
	fmtHHmm,
	fmtScaleLabel,
	spectralBins,
	type SpectralBins,
} from "../lib/board/activity-scale.ts";
import type { AttemptTimeline } from "../lib/board/activity-contract.ts";
import {
	attemptAxis,
	attemptPlot,
	attemptStripHandlers,
	attemptStripStyles,
	attemptWallMs,
	type AttemptStripHost,
} from "./attempt-strip.ts";
import { dualShort, dualStamp } from "../lib/wallclock.ts";

class KlhCardActivity extends LitElement {
	static properties = {
		points: { attribute: false },
		wallMs: { attribute: false },
		attempt: { attribute: false },
		mode: { attribute: false },
		_width: { state: true },
		_tip: { state: true },
		_slot: { state: true },
	};
	declare points: [number, number, number, number][];
	declare wallMs: number | null;
	/** AttemptTimeline (the wiring leaf validates through the contract). */
	declare attempt: AttemptTimeline | null;
	/** which strip contents render: "spend" (default) or "attempt". */
	declare mode: "spend" | "attempt";
	/** the MEASURED track width (W2514 B1: reactive state — assigning it in
	 *  firstUpdated re-renders, so the first paint after upgrade already
	 *  bins at the real card width instead of the 240px floor). */
	declare _width: number;
	/** tooltip text (null = hidden). */
	declare _tip: string | null;
	/** keyboard-focused bin index (-1 = none). */
	declare _slot: number;

	static styles = [
		css`
		:host {
			display: block;
			font: 11px/1.5 ui-sans-serif, system-ui;
		}
		.plot {
			display: block;
			width: 100%;
			height: 40px;
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
		/* B2 (W2514): the hairline carries exact duration text — keyboard
		   focus must be visible, same ring as the plot. */
		.hairline:focus-visible {
			outline: 2px solid var(--klh-accent, #d8900f);
			outline-offset: 1px;
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
	`,
		attemptStripStyles,
	];

	constructor() {
		super();
		this.points = [];
		this.wallMs = null;
		this.attempt = null;
		this.mode = "spend";
		this._width = 0;
		this._tip = null;
		this._slot = -1;
	}

	// the measured track (W1203): recompute on width change.
	private _ro: ResizeObserver | null = null;

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
		// W2267.4.2.1 repair (behavior proof 4): a MOVED/RECONNECTED host
		// never gets firstUpdated again — re-observe immediately so the
		// geometry tracks the new position/size from the first frame back.
		const el = this._plotEl();
		if (el && this._ro) this._ro.observe(el);
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

	// W2267.4.2.1 repair (behavior proof 4): mode switches swap the plot
	// element — the RO must observe the NEW node or geometry freezes at
	// the old element. Re-observing is idempotent for a same node.
	protected updated(): void {
		const el = this._plotEl();
		if (el && this._ro) this._ro.observe(el);
	}

	// W2267.4.2.1 repair (behavior proof 5): data becoming empty or a
	// payload leaving the window must dismiss a stale inspection — the
	// tip is derived state, never persists past its source.
	protected update(changed: Map<string, unknown>): void {
		super.update(changed);
		if (changed.has("points") || changed.has("attempt")) {
			const spec = this._spec;
			const attemptEmpty = this.mode === "attempt" && !this.attempt;
			if (!spec.hasData || attemptEmpty) this._hideTip();
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

	/** fresh stacked over cached, sparkSvg parity: 0.5px floor, 1px inset.
	 *  svg`` templates — html`` here mints XHTML-namespace rects the
	 *  browser refuses to size (0x0 bbox, root-proven W2267.4.2.1). */
	private _barRects(
		b: { fresh: number; cached: number },
		x: number,
		maxV: number,
	): TemplateResult {
		const h = 40;
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
				svg`<rect
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
		const span = durationSpan(this._hairWallMs(), w);
		if (!span.visible) return null;
		return html`<div
			class="hairline${span.saturated ? " saturated" : ""}"
			role="img"
			aria-label="elapsed ${fmtDurationExact(this._hairWallMs() ?? 0)} of ${fmtScaleLabel()} scale${span.saturated ? " — saturated at full width" : ""}"
			title="elapsed ${fmtDurationExact(this._hairWallMs() ?? 0)} of ${fmtScaleLabel()} scale${span.saturated ? " — saturated at full width" : ""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${span.start.toFixed(1)}px;width:${(span.end - span.start).toFixed(1)}px"
			></span>
		</div>`;
	}

	/** B2 (W2514): focus states the exact duration + shared scale — same
	 *  .tip surface the plot uses, pinned to the hairline's own geometry
	 *  (never the pointer, which never came). */
	private _hairFocus = (): void => {
		const w = this._width || 240;
		const span = durationSpan(this._hairWallMs(), w);
		if (!span.visible) return;
		this._slot = -1;
		this._tip =
			`elapsed ${fmtDurationExact(this._hairWallMs() ?? 0)} of ` +
			`${fmtScaleLabel()} scale` +
			(span.saturated ? " — saturated at full width" : "");
		this.requestUpdate();
		const r = this._plotEl()?.getBoundingClientRect();
		if (r)
			this._placeTip(
				r.left + (span.center / Math.max(1, w)) * r.width,
				r.bottom + 2,
			);
	};

	/** Esc on the hairline hides the tip and drops focus; arrows do
	 *  nothing here — bin walking belongs to the focused plot. */
	private _hairKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			this._hideTip();
			this.requestUpdate();
			(e.target as HTMLElement).blur();
		}
	};

	/** the one-line axis: compact local HH:mm window start | TZ + bin width
	 *  | compact end (owner-approved W2267.4.2.1 form — the full dual
	 *  UTC/local stamps stay on the hover/keyboard inspector, never here).
	 *  Both ends come from the ONE honest domain: what is labeled is what
	 *  is plotted, hoverable and keyboard-walkable. */
	private _axisHtml(spec: SpectralBins): TemplateResult {
		const tz = this._tzLabel();
		return html`<div class="axis">
			<span>${spec.hasData ? fmtHHmm(spec.windowStart ?? 0) : ""}</span>
			<span
				>${
					spec.hasData ? `${tz} · ${spec.slotMs / 60000}m/bin` : "no activity"
				}</span
			>
			<span>${spec.hasData ? fmtHHmm(spec.windowEnd ?? 0) : ""}</span>
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

	/** viewport-safe placement: right of the cursor, flip above when tight.
	 *  W2267.4.2.1 repair (behavior proof 5): the FIRST pointer event sets
	 *  _tip and asks Lit to render the .tip — synchronously the element
	 *  does not exist yet, so the placement defers to updateComplete and
	 *  runs once the tip is really in the DOM (correctly positioned, not
	 *  merely present). */
	private _placeTip(x: number, y: number): void {
		const place = (): void => {
			const tip = this.renderRoot.querySelector<HTMLElement>(".tip");
			if (!tip) return;
			const left = Math.min(x + 10, window.innerWidth - tip.offsetWidth - 8);
			const above = y - tip.offsetHeight - 10;
			tip.style.left = `${Math.max(8, left)}px`;
			tip.style.top = `${above >= 8 ? above : y + 12}px`;
		};
		const tip = this.renderRoot.querySelector<HTMLElement>(".tip");
		if (tip) {
			place();
			return;
		}
		this.updateComplete.then(place).catch(() => undefined);
	}

	// ── attempt mode (W2267.4.2.1): the SAME strip assembly — one 40px
	// plot band, hairline, compact axis — attempt geometry inside (the
	// contents module: attempt-strip.ts). Never a second chart: mode
	// switches the CONTENTS in place.

	/** the hairline's duration source: spend wall or attempt claim. */
	private _hairWallMs(): number | null {
		return this.mode === "attempt" && this.attempt
			? attemptWallMs(this.attempt)
			: this.wallMs;
	}

	/** the host face attempt-strip handlers drive (tip/slot/place). */
	private get _stripHost(): AttemptStripHost {
		return {
			setTip: (text, slot) => {
				this._tip = text;
				this._slot = slot;
				this.requestUpdate();
			},
			placeTip: (x, y) => this._placeTip(x, y),
			hide: () => {
				this._hideTip();
				this.requestUpdate();
			},
			slot: () => this._slot,
		};
	}

	private _attemptHandlers = attemptStripHandlers(this._stripHost);

	/** attempt-mode render: same plot band + hairline + axis assembly. */
	private _renderAttempt(): TemplateResult {
		const a = this.attempt;
		const w = this._width || 240;
		if (!a) {
			// explicit empty state — never a zero-valued success trace
			return html`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;
		}
		return html`
			${attemptPlot(a, w, this._attemptHandlers)}
			${this._hairlineHtml()}
			${attemptAxis(a, this._tzLabel())}
			${this._tip ? this._tipHtml() : null}
		`;
	}

	protected render() {
		if (this.mode === "attempt") return this._renderAttempt();
		const spec = this._spec;
		return html`
			<svg
				class="plot"
				viewBox="0 0 ${this._width || 240} 40"
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
