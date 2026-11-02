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
import { html, LitElement, svg, type TemplateResult } from "lit";
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
	attemptRows,
	attemptTip,
	type AttemptHit,
} from "../lib/board/attempt-render.ts";
import {
	attemptAxis,
	attemptIntervalStamp,
	attemptPlot,
	attemptStripHandlers,
	attemptStripStyles,
	attemptWallMs,
	type AttemptStripHost,
	type AttemptTipRef,
} from "./attempt-strip.ts";
import {
	humanZoneWord,
	localDate,
	utcDate,
	utcShort,
} from "../lib/wallclock.ts";
import { CARD_ACTIVITY_STYLES } from "./klh-card-activity-css.ts";

/** The ONE activity strip (definition only — registration rides the
 * workspace entry klh-board-register.ts, root pointer #103173). */
export class KlhCardActivity extends LitElement {
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
	/** identity of the inspected attempt row (poll retention contract). */
	declare _tipRef: AttemptTipRef | null;
	/** identity of the inspected spend bin — its START timestamp, never a
	 *  numeric slot (the window re-derives every poll; W2267.4.2.1.1). */
	declare _tipTs: number | null;

	static styles = [CARD_ACTIVITY_STYLES, attemptStripStyles];

	constructor() {
		super();
		this.points = [];
		this.wallMs = null;
		this.attempt = null;
		this.mode = "spend";
		this._width = 0;
		this._tip = null;
		this._slot = -1;
		this._tipRef = null;
		this._tipTs = null;
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

	// W2267.4.2.1 repair (behavior proof 5) + W2267.4.2.1.1 poll retention
	// (root #102925): a payload refresh keeps the inspection while the
	// referenced row REMAINS — re-texted from the FRESH payload (a grown
	// segment shows its new duration; the tip is derived state, never a
	// stale copy) and the keyboard walk index follows the matched row's
	// fresh position (rows may be inserted before it). Dismisses when the
	// source is gone: spend data empty, attempt payload empty, or the
	// referenced attempt row no longer present.
	protected update(changed: Map<string, unknown>): void {
		super.update(changed);
		if (!changed.has("points") && !changed.has("attempt")) return;
		if (this.mode === "attempt") {
			if (!this.attempt || !this._tipRef) {
				this._hideTip();
				return;
			}
			const { milestones, segs } = attemptRows(this.attempt);
			const rows = [...milestones, ...segs];
			const ref = this._tipRef;
			const idx = rows.findIndex(
				(r) => r.kind === ref.kind && r.start === ref.start,
			);
			if (idx < 0) {
				this._hideTip();
				return;
			}
			this._tip = attemptTip(
				rows[idx] as AttemptHit,
				this.attempt,
				attemptIntervalStamp,
				fmtDurationExact,
			);
			this._slot = idx;
			return;
		}
		// spend mode: the inspected bin is its START timestamp, never a slot
		// index — the window re-derives every poll (W2267.4.2.1.1, #102929).
		const spec = this._spec;
		if (!spec.hasData || this._tipTs === null) {
			if (!spec.hasData) this._hideTip();
			return;
		}
		const slot = Math.floor(
			(this._tipTs - (spec.windowStart ?? 0)) / spec.slotMs,
		);
		if (slot < 0 || slot >= spec.count) {
			this._hideTip(); // the bin left the window — stale inspection out
			return;
		}
		this._slot = slot;
		this._tip = this._tipText(spec, slot);
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
		this._tipTs = (spec.windowStart ?? 0) + slot * spec.slotMs;
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
		this._tipTs = (spec.windowStart ?? 0) + slot * spec.slotMs;
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
		this._tipRef = null;
		this._tipTs = null;
	}

	/** exact tooltip text for one bin — ONE compact human stamp line
	 *  (owner-approved 2026-11-02: the dual UTC/local pair repeated three
	 *  times per hover was noise), exact counts below it. */
	private _tipText(spec: SpectralBins, slot: number): string {
		const b = spec.bins[slot];
		const t0 = (spec.windowStart ?? 0) + slot * spec.slotMs;
		// #103191/#103233 exact owner pattern: line 1 `2 Nov 2026 · 21:51
		// UTC+01:00`, line 2 `20:51 UTC · 3-minute bin` — the UTC twin
		// carries its date ONLY when it differs from the line-1 local date
		// (utcShort rule); no interval repeat, no seconds.
		const lines = [
			humanZoneWord(t0),
			`${utcShort(t0, localDate(t0) !== utcDate(t0))} · ${spec.slotMs / 60000}-minute bin`,
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
		if (!bars.length) return html``;
		// W2267.4.2.2 (#103177): svg`` template — html`` here would mint
		// XHTML-namespace defs/gradient/stop elements the renderer ignores
		// (the same bug class the rects already fixed). ONE defs pair for
		// the whole plot; each bar fades along its own height
		// (objectBoundingBox) — STRONG at the baseline, faint at the tips
		// (approved 09 direction). Identical defs across strips make the
		// duplicate-id resolution benign (first match wins, all equal).
		return svg`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${bars}`;
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
		// the hairline is its OWN inspection kind — drop row/bin identities so
		// a later poll cannot overwrite it with a re-texted row tip.
		this._tipRef = null;
		this._tipTs = null;
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

	/** the host face attempt-strip handlers drive (tip/slot/place/ref). */
	private get _stripHost(): AttemptStripHost {
		return {
			setTip: (text, slot, ref) => {
				this._tip = text;
				this._slot = slot;
				this._tipRef = ref ?? null;
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
