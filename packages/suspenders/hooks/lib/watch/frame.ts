// hooks/lib/watch/frame.ts — W522 fleet-watch rendering: pure model→frame
// and the flicker-free diff emitter. A frame is an array of styled lines
// (≤ width-1 visible cols each — content never reaches the last column, so
// no line wraps, no pane scroll). The emitter repositions with \x1b[<L-1>A
// and rewrites only CHANGED lines (\x1b[2K + content, \x1b[K clear-EOL) —
// no alt-screen, no full clear, no flicker.
import type { LaneRow } from "./sources.ts";

export interface BoardTaskRow {
	id: string;
	title: string;
	state: string;
	owner_sid: string | null;
	owner_label: string | null;
	age_s: number;
	tag_color: string | null;
}
export interface WatchModel {
	head: string | null;
	lanes: LaneRow[];
	tasks: BoardTaskRow[];
	totalTasks: number;
	boardOk: boolean;
	boardMs: number;
	now: number;
	width: number;
	height: number;
	top: number;
	fleetRoot: string;
}

// ─── ANSI primitives (zero-dep) ─────────────────────────────────────────────
export const RESET = "\x1b[0m";
const paint = (code: string, s: string): string => `\x1b[${code}m${s}${RESET}`;
export const dim = (s: string): string => paint("2", s);
const bold = (s: string): string => paint("1", s);
const cyan = (s: string): string => paint("36", s);
const green = (s: string): string => paint("32", s);
const red = (s: string): string => paint("31", s);
const amber = (s: string): string => paint("33", s);
const rgb = (hex: string, s: string): string => {
	const n = hex.length === 7 ? Number.parseInt(hex.slice(1), 16) : NaN;
	return Number.isNaN(n)
		? s
		: paint(`38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`, s);
};

/** Visible length (ANSI-stripped, code points). */
export const visibleLen = (s: string): number =>
	[...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

/** ANSI-aware truncate — never past `width` visible cols; a cut re-opens
 *  reset so the pane's cursor state stays clean. */
export function truncate(s: string, width: number): string {
	if (visibleLen(s) <= width) return s;
	const out: string[] = [];
	let n = 0;
	for (const tok of s.split(/(\x1b\[[0-9;]*m)/)) {
		if (tok.startsWith("\x1b[")) {
			out.push(tok);
			continue;
		}
		for (const ch of tok) {
			if (n >= width) return out.join("") + RESET;
			out.push(ch);
			n++;
		}
	}
	return out.join("") + RESET;
}

/** 45s · 3m · 2h · 6d — the claim-age vocabulary. */
export function fmtAge(s: number): string {
	if (!Number.isFinite(s) || s < 0) return "—";
	if (s < 60) return `${Math.floor(s)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

/** Row pick for the tasks pane: active claims first (longest-held first —
 *  a stuck lane surfaces at the top), then READY (newest activity first),
 *  DONE/CANCELLED drop. Capped at `cap` rows. */
export function selectTasks(rows: BoardTaskRow[], cap: number): BoardTaskRow[] {
	const weight = (st: string): number =>
		st === "RUNNING" || st === "CLAIMED"
			? 0
			: st === "BLOCKED" || st === "PAUSED" || st === "ORPHANED"
				? 1
				: st === "READY"
					? 2
					: 3;
	const keep = rows.filter((r) => weight(r.state) < 3);
	keep.sort((a, b) => weight(a.state) - weight(b.state) || b.age_s - a.age_s);
	return keep.slice(0, cap);
}

/** Lane-row glyph/color — the coord fleet vocabulary. */
export function laneGlyph(state: string): [string, (s: string) => string] {
	if (state === "PAUSE_REQUESTED") return ["◐", amber];
	if (state === "PAUSED") return ["⏸", amber];
	if (state === "RESUME_READY") return ["↻", cyan];
	if (state === "BLOCKED") return ["⚠", red];
	return ["▶", green];
}

/** State glyph/color — the work-graph GLYPH vocabulary (work.ts). */
export function stateGlyph(st: string): [string, (s: string) => string] {
	if (st === "READY") return ["·", cyan];
	if (st === "CLAIMED") return ["◐", cyan];
	if (st === "RUNNING") return ["▶", green];
	if (st === "BLOCKED") return ["⚠", red];
	if (st === "PAUSED") return ["⏸", amber];
	if (st === "DONE") return ["✓", dim];
	return ["×", dim];
}

/** Model → styled frame lines. Every line is truncated to width-1 so the
 *  terminal never wraps; height caps lanes then tasks, overflow summarized. */
export function buildFrame(m: WatchModel): string[] {
	const w = m.width;
	const lines: string[] = [];
	const clock = new Date(m.now).toISOString().slice(11, 19);
	const push = (s: string): void => {
		lines.push(truncate(s, w - 1));
	};

	push(`${bold("fleet-watch")}${dim(` · @${m.head ?? "no-head"} · ${clock}`)}`);
	const accent = m.tasks.find((t) => t.tag_color)?.tag_color ?? null;
	const rule = accent ? rgb(accent, "─".repeat(w - 1)) : dim("─".repeat(w - 1));
	push(rule);

	// lanes pane — live lanes lead, registry-missing (host) lanes trail
	const live = m.lanes.filter((l) => l.live !== false);
	const lanesCap = Math.max(
		2,
		Math.min(live.length, Math.floor((m.height - 4) / 3)),
	);
	const total = m.lanes.length;
	push(
		`${green("▶")} lanes ${live.filter((l) => l.live).length} live · ${total} claimed${lanesCap < total ? dim(` (showing ${lanesCap})`) : ""}`,
	);
	for (const l of [...live]
		.sort(
			(a, b) =>
				Number(b.live === true) - Number(a.live === true) ||
				Number(b.live === null) - Number(a.live === null) ||
				a.sid.localeCompare(b.sid),
		)
		.slice(0, lanesCap)) {
		const [g, col] = laneGlyph(l.state);
		const liveMark =
			l.live === null ? dim(" ") : l.live ? green("●") : red("×");
		const item = l.item ? cyan(l.item) : dim("—");
		const st = l.itemState ? col(l.itemState) : dim(l.state);
		const age = l.ageS !== null ? dim(fmtAge(l.ageS)) : "";
		const who = l.name ?? l.intent ?? "";
		push(
			`${liveMark} ${dim(l.sid.slice(0, 8))} ${item} ${st} ${age} ${dim(who)}`,
		);
	}

	// tasks pane — selectTasks order, tag dot in the .prefer color; rows
	// capped by the height budget left under the lanes pane + --top
	const laneRows = live.slice(0, lanesCap).length;
	const taskCap = Math.max(1, m.height - 5 - laneRows);
	const shown = selectTasks(m.tasks, Math.min(m.top, taskCap));
	push(
		`${cyan("●")} tasks ${m.totalTasks} tracked${shown.length < m.totalTasks ? dim(` (showing ${shown.length})`) : ""}`,
	);
	for (const t of shown) {
		const [g, col] = stateGlyph(t.state);
		const dot = t.tag_color ? rgb(t.tag_color, "●") : dim("·");
		const owner = t.owner_sid ? dim(` @${t.owner_sid.slice(0, 8)}`) : "";
		push(
			`${dot} ${col(g)} ${cyan(t.id)} ${t.title} ${dim(fmtAge(t.age_s))}${owner}`,
		);
	}

	// footer — feed health + root; errors surface here, never blank the frame
	const foot = [
		m.boardOk
			? `board ok ${m.boardMs}ms`
			: `${red("board down")} — tasks stale`,
		dim(m.fleetRoot),
	].join(" · ");
	push(foot);
	return lines;
}

/** Flicker-free diff emitter. First frame writes everything (each line
 *  EOL-cleared); later frames reposition and rewrite ONLY changed lines.
 *  Returns the frame that must become the next `prev`. */
export function emitFrame(
	prev: string[] | null,
	next: string[],
	tty: boolean,
	write: (s: string) => void,
): string[] {
	if (!tty || prev === null || prev.length === 0) {
		if (!tty) {
			write(next.join("\n"));
		} else {
			write(next.map((l) => `${l}\x1b[K`).join("\n"));
		}
		return next;
	}
	const l = prev.length;
	let out = `\r\x1b[${l - 1}A`;
	for (let i = 0; i < next.length; i++) {
		if (prev[i] !== next[i]) out += `\x1b[2K${next[i]}`;
		out += "\x1b[K";
		out += i < next.length - 1 ? "\n" : "";
	}
	if (next.length < l) out += "\x1b[J"; // shrink: clear the stale bottom
	write(out);
	return next;
}
