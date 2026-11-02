// hooks/board-html/attempt-strip.ts — W2267.4.2.1: the attempt-mode
// CONTENTS of the card activity strip. One job: turn a validated
// AttemptTimeline into the same strip assembly spend mode uses — one 40px
// plot band, the 1px duration hairline, the compact HH:mm axis — with
// segment rects, artifact diamonds, hover/keyboard inspection and the
// explicit empty state. Consumed by klh-card-activity.ts (the strip owner);
// never a second chart. Geometry/tip text are the pure lib
// (hooks/lib/board/attempt-render.ts); SVG children ride svg`` templates
// only — html`` rects mint XHTML namespace and render 0x0.
import { css, html, svg, type TemplateResult } from "lit";
import type { AttemptTimeline } from "../lib/board/activity-contract.ts";
import { fmtDurationExact, fmtHHmm } from "../lib/board/activity-scale.ts";
import {
	ATTEMPT_MS_HALF,
	ATTEMPT_SEG_H,
	ATTEMPT_SEG_Y,
	attemptRows,
	attemptTip,
	attemptX,
	hitTest,
	type AttemptHit,
} from "../lib/board/attempt-render.ts";
// W2267.4.2.2: compact stamps — the full dual UTC/local pair repeated three
// times per hover was noise; #103233/#103234 pin the exact shortforms.
import { humanZoneWord, zoneInterval } from "../lib/wallclock.ts";

/** identity of the inspected row — survives payload refreshes so the owner
 *  can tell "the referenced segment remains" (retain + retext) from "it is
 *  gone" (dismiss the stale inspection). W2267.4.2.1.1 poll contract. */
export interface AttemptTipRef {
	kind: string;
	start: number;
}

/** how the strip reports inspection state back to the strip owner. */
export interface AttemptStripHost {
	/** set tooltip text + the _slot walk index + the inspected row identity
	 *  (the owner re-renders; the ref drives poll-refresh retention). */
	setTip(text: string | null, slot: number, ref?: AttemptTipRef | null): void;
	/** viewport-clamped placement the host owns (same .tip surface). */
	placeTip(x: number, y: number): void;
	/** hide + drop walk index (pointerleave / Escape / empty data). */
	hide(): void;
	/** the current walk index (keyboard nav steps from here). */
	slot(): number;
}

/** claim elapsed on the ONE shared 24h duration scale (never completion %):
 *  claimStart → claimEnd, clamped into the fixed attempt window. */
export function attemptWallMs(a: AttemptTimeline): number | null {
	const end = a.attempt.claimEnd ?? a.windowEnd;
	const ms = Math.min(end, a.windowEnd) - a.attempt.claimStart;
	return ms > 0 ? ms : null;
}

/** #103234 stamp for attemptTip's line-1/line-2 contract: an instant
 *  renders humanZoneWord; an interval [t0, t1] renders the zoneInterval
 *  pair (local line + UTC twin) joined by a newline. */
export function attemptIntervalStamp(t: number, t1?: number): string {
	return t1 === undefined ? humanZoneWord(t) : zoneInterval(t, t1).join("\n");
}

/** segment rects + artifact diamonds — svg`` templates (SVG namespace). */
function attemptSvg(a: AttemptTimeline, w: number): TemplateResult {
	const { segs, milestones } = attemptRows(a);
	const parts: TemplateResult[] = [];
	for (const s of segs) {
		const x0 = attemptX(s.start, a.windowStart, a.windowEnd, w);
		const x1 = Math.max(x0 + 1, attemptX(s.end, a.windowStart, a.windowEnd, w));
		parts.push(
			svg`<rect
				class="at-${s.kind}"
				x=${x0.toFixed(1)}
				y=${ATTEMPT_SEG_Y}
				width=${(x1 - x0).toFixed(1)}
				height=${ATTEMPT_SEG_H}
				rx="2"
			/>`,
		);
	}
	for (const m of milestones) {
		const mx = attemptX(m.start, a.windowStart, a.windowEnd, w);
		const cy = ATTEMPT_SEG_Y + ATTEMPT_SEG_H / 2;
		parts.push(
			svg`<path
				class="at-ms"
				d="M ${mx.toFixed(1)},${(cy - ATTEMPT_MS_HALF).toFixed(1)} l ${ATTEMPT_MS_HALF},${ATTEMPT_MS_HALF} l -${ATTEMPT_MS_HALF},${ATTEMPT_MS_HALF} l -${ATTEMPT_MS_HALF},-${ATTEMPT_MS_HALF} Z"
			/>`,
		);
	}
	return html`${parts}`;
}

/** the attempt-mode event handlers — the SELF-CONTAINED face
 *  attemptPlot binds (hover/hide/keydown/slot). Root-proven #101559:
 *  a face missing slot()/hide() throws on the first ArrowRight. */
export interface AttemptStripHandlers {
	hover(e: PointerEvent, a: AttemptTimeline | null): void;
	hide(): void;
	keydown(e: KeyboardEvent, a: AttemptTimeline): void;
	slot(): number;
}

/** identity of one hit — kind + start (milestone ts or segment start). */
const refOf = (hit: AttemptHit): AttemptTipRef => ({
	kind: hit.kind,
	start: hit.start,
});

export function attemptStripHandlers(
	host: AttemptStripHost,
): AttemptStripHandlers {
	const hover = (e: PointerEvent, a: AttemptTimeline | null): void => {
		const svgEl = e.currentTarget as SVGSVGElement | null;
		if (!a || !svgEl) {
			host.hide();
			return;
		}
		const r = svgEl.getBoundingClientRect();
		if (r.width === 0) return;
		const hit = hitTest(
			attemptRows(a),
			e.clientX - r.left,
			a.windowStart,
			a.windowEnd,
			r.width,
		);
		if (!hit) {
			host.hide();
			return;
		}
		host.setTip(
			attemptTip(hit, a, attemptIntervalStamp, fmtDurationExact),
			-1,
			refOf(hit),
		);
		host.placeTip(e.clientX, e.clientY);
	};
	const keydown = (e: KeyboardEvent, a: AttemptTimeline): void => {
		if (e.key === "Escape") {
			host.hide();
			(e.target as HTMLElement).blur();
			return;
		}
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const slot = host.slot();
		const { milestones, segs } = attemptRows(a);
		const rows = [...milestones, ...segs];
		if (!rows.length) return;
		const dir = e.key === "ArrowLeft" ? -1 : 1;
		const i = Math.max(0, Math.min(rows.length - 1, slot + dir));
		const hit = rows[i];
		if (!hit) return;
		host.setTip(
			attemptTip(hit, a, attemptIntervalStamp, fmtDurationExact),
			i,
			refOf(hit),
		);
		const svgEl = e.currentTarget as SVGSVGElement | null;
		if (svgEl) {
			const r = svgEl.getBoundingClientRect();
			const x = attemptX(hit.start, a.windowStart, a.windowEnd, r.width);
			host.placeTip(r.left + x, r.top + 8);
		}
	};
	return {
		hover,
		hide: () => host.hide(),
		keydown,
		slot: () => host.slot(),
	};
}

/** the attempt-mode axis: compact local HH:mm ends (owner #100723). */
export function attemptAxis(a: AttemptTimeline, tz: string): TemplateResult {
	return html`<div class="axis">
		<span>${fmtHHmm(a.windowStart)}</span>
		<span>${tz} · ${a.binMs / 60000}m/bin</span>
		<span>${fmtHHmm(a.windowEnd)}</span>
	</div>`;
}

/** the full attempt-mode plot band. The strip owner composes this inside
 *  its one strip assembly (hairline + axis stay the owner's shared parts). */
export function attemptPlot(
	a: AttemptTimeline,
	w: number,
	handlers: ReturnType<typeof attemptStripHandlers>,
): TemplateResult {
	return html`<svg
		class="plot"
		viewBox="0 0 ${w} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${a.binMs / 60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(e: PointerEvent) => handlers.hover(e, a)}
		@pointerleave=${() => handlers.hide()}
		@keydown=${(e: KeyboardEvent) => handlers.keydown(e, a)}
	>
		${attemptSvg(a, w)}
	</svg>`;
}

/** attempt-mode styles — composed into the strip owner's static styles. */
export const attemptStripStyles = css`
	.plot rect.at-queue {
		fill: var(--klh-chart-axis, #898781);
	}
	.plot rect.at-firstbyte {
		fill: var(--klh-accent, #d8900f);
	}
	.plot rect.at-tool {
		fill: var(--klh-ok, #5c7a35);
	}
	.plot rect.at-pause {
		fill: var(--klh-warn, #b8860b);
	}
	.plot rect.at-unknown {
		fill: var(--klh-edge, rgba(128, 128, 128, 0.35));
	}
	.plot path.at-ms {
		fill: var(--klh-ink, #e8e6e1);
		stroke: var(--klh-edge, rgba(255, 255, 255, 0.4));
		stroke-width: 0.5;
	}
	.attempt-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 40px;
		font: 400 11px/1.5 ui-monospace, SFMono-Regular, monospace;
		color: var(--klh-chart-axis, #898781);
	}
`;
