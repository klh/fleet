// hooks/tracker/render.ts — W575: full-frame ANSI rendering. Lanes are
// columns, the bounded timeline flows top→bottom, cells are `ID<symbol>`
// (the symbol is the accessible non-colour channel; colour is additive).
// Narrow terminals get a column window around the cursor, never truncation.
import { type CellState, SYMBOLS } from "./model.ts";
import type { Detail, LaneColumn, Snapshot, Transition } from "./snapshot.ts";

export interface FrameOpts {
	width: number;
	height: number;
	useColor: boolean;
	selRow: number; // index into visible transitions, 0 = newest
	selCol: number; // index into columns, 0 = queue column
	detail: Detail | null;
}

const GUTTER = "  ";

function paint(s: string, code: string, useColor: boolean): string {
	return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const STATE_COLOR: Record<CellState, string> = {
	queued: "2",
	claimed: "36",
	running: "32",
	decision: "33",
	complete: "32;1",
	failed: "31;1",
	stalled: "31",
	unknown: "2",
};

export function statePaint(
	s: string,
	state: CellState,
	useColor: boolean,
): string {
	return paint(s, STATE_COLOR[state], useColor);
}

export function cellText(t: Transition): string {
	return `${t.item ?? "—"}${SYMBOLS[t.state]}`;
}

// Column width: the queue column is fixed; a lane column fits its name.
function laneW(l: LaneColumn | null): number {
	return l ? Math.max(12, l.name.length + 8) : 8 + GUTTER.length;
}

export function renderFrame(snap: Snapshot, o: FrameOpts): string {
	const width = Math.max(20, o.width);
	const lines: string[] = [];
	const c = (s: string, code: string): string => paint(s, code, o.useColor);

	// lane header: liveness glyph + name (legend always on the first line)
	lines.push(
		c(
			"legend · queued claimed ▶ running ? decision ✓ complete ✗ failed ! stalled ~ unknown",
			"2",
		),
	);
	const shown = visibleCols(snap, width, o.selCol);
	const laneHeader = shown
		.map((ci) => {
			if (ci === 0) return c("queue".padEnd(8), "2");
			const l = snap.columns[ci - 1];
			return c(
				`${l.live ? "▶" : l.stalled ? "×" : l.unknown ? "?" : "◇"} ${l.name}`,
				l.live ? "32" : l.stalled ? "31" : "36",
			);
		})
		.join(GUTTER);
	lines.push(laneHeader || c("(no claimed lanes)", "2"));

	// timeline rows, newest at the bottom of the visible window
	const headerRows = lines.length + 1;
	const footerRows = 2; // spacer + key hints
	const detailRows = o.detail
		? Math.min(10, Math.max(6, Math.floor(o.height / 3)))
		: 0;
	const visible = Math.max(
		1,
		o.height - headerRows - footerRows - detailRows - 1, // 1 = now-row
	);
	const rows = snap.transitions.slice(
		Math.max(0, snap.transitions.length - visible - o.selRow),
		snap.transitions.length - o.selRow || undefined,
	);

	for (const t of rows) {
		const cells: string[] = [];
		for (const ci of shown) {
			const inCol =
				ci === 0 ? t.lane === null : t.lane === snap.columns[ci - 1]?.sid;
			const cell = inCol ? cellText(t) : "";
			const w = ci === 0 ? 8 : laneW(snap.columns[ci - 1]);
			const pad = " ".repeat(Math.max(0, w - cell.length));
			const distFromNewest =
				snap.transitions.length - 1 - snap.transitions.indexOf(t);
			const selected =
				inCol &&
				o.detail === null &&
				distFromNewest === o.selRow &&
				ci === o.selCol;
			cells.push(
				selected
					? paint(cell + pad, "7", o.useColor)
					: cell
						? statePaint(cell, t.state, o.useColor)
						: pad,
			);
		}
		lines.push(cells.join(GUTTER).replace(/\s+$/, ""));
	}

	// now-row: the derived current status per visible column
	const nowCells = shown.map((ci) => {
		if (ci === 0) return c(`q:${snap.queueDepth}`.padEnd(8), "2");
		const l = snap.columns[ci - 1];
		return statePaint(
			`${l.live ? "▶" : l.stalled ? "!" : l.unknown ? "~" : "◇"} ${l.name.slice(0, 6)}`.padEnd(
				laneW(l) - GUTTER.length,
			),
			l.stalled
				? "stalled"
				: l.unknown
					? "unknown"
					: l.live
						? "running"
						: "claimed",
			o.useColor,
		);
	});
	lines.push(c("─".repeat(width), "2"));
	lines.push(nowCells.join(GUTTER).replace(/\s+$/, ""));

	// detail pane: the keyboard-inspected completion summary
	if (o.detail) {
		lines.push(c("─".repeat(width), "2"));
		lines.push(...detailLines(o.detail, width, detailRows));
	}

	lines.push(c("↑↓ rows · ←→ lanes · enter summary · r resync · q quit", "2"));
	return lines.join("\n");
}

// The columns visible in `width`, queue first. When the fleet is wider than
// the terminal, the window slides so the cursor's column stays on screen.
export function visibleCols(
	snap: Snapshot,
	width: number,
	selCol: number,
): number[] {
	const totalCols = snap.columns.length + 1;
	const fit = (from: number): number[] => {
		const shown: number[] = [];
		let acc = laneW(null);
		if (from === 0) shown.push(0);
		for (let i = Math.max(1, from); i < totalCols; i++) {
			const w = laneW(snap.columns[i - 1]);
			if (acc + w > width) break;
			acc += w;
			shown.push(i);
		}
		return shown;
	};
	const base = fit(0);
	if (selCol === 0 || base.includes(selCol)) return base;
	// slide: drop the queue column first, then walk the origin back until the
	// cursor's column fits the width
	for (let from = selCol; from >= 1; from--) {
		const w = fit(from);
		if (w.includes(selCol)) return w;
	}
	return fit(selCol); // single-column fallback: the cursor column alone
}

function detailLines(d: Detail, width: number, maxRows: number): string[] {
	const out: string[] = [];
	const push = (s: string): void => {
		if (out.length < maxRows) out.push(s.slice(0, width));
	};
	push(
		`■ ${d.project}/${d.item} ${d.state}${d.owner ? ` — ${d.owner.slice(0, 10)}` : ""}${d.resultSha ? ` @${d.resultSha.slice(0, 8)}` : ""}`,
	);
	push(d.title.slice(0, width));
	if (d.summary) for (const seg of wrap(d.summary, width - 2)) push(`  ${seg}`);
	if (d.completedBy)
		push(
			`  ✓ ${d.completedBy.slice(0, 10)} ${new Date(d.completedAt).toISOString().slice(0, 16).replace("T", " ")}`,
		);
	if (d.capsule) push(`  ▸ ${d.capsule.slice(0, width - 4)}`);
	return out.slice(0, maxRows);
}

function wrap(s: string, width: number): string[] {
	if (width < 10) return [s];
	const words = s.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if (cur && `${cur} ${w}`.length > width) {
			lines.push(cur);
			cur = w;
		} else cur = cur ? `${cur} ${w}` : w;
	}
	if (cur) lines.push(cur);
	return lines;
}
