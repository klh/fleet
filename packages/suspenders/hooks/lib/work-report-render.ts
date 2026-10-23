// hooks/lib/work-report-render.ts — W1131 §2 format-by-MEDIUM renderers.
// Every format renders FROM the versioned contract (work-report.ts), never
// from the graph: json = the contract verbatim, tty = aligned table with
// OSC 8 deep-links + optional ANSI, md = a markdown list with links outside
// code fences, plain = TSV for pipes. Colour never encodes state alone —
// every row already carries glyph + word; --no-color / NO_COLOR /
// TERM=dumb kill it, FORCE_COLOR forces it on a non-TTY.

import {
	agentClock,
	buildReportContract,
	compactTokens,
	type ReportContract,
	type ReportItem,
	type ReportRow,
	osc8Link,
	TASK_CAP,
	CACHE_MARK,
	CACHE_LEGEND,
} from "./work-report.ts";
import { reportBoardBase } from "./work-report-live.ts";

/** The §2 formats: chosen by MEDIUM, not by CLI — --format tty|md|plain|json. */
export type ReportFormat = "tty" | "md" | "plain" | "json";

/** §2 colour decision: NO_COLOR (non-empty) and TERM=dumb kill; FORCE_COLOR
 *  forces on; otherwise a real TTY and no --no-color. */
export const colorEnabled = (opts: {
	tty: boolean;
	noColor?: boolean;
}): boolean => {
	if (process.env.NO_COLOR) return false;
	if (process.env.TERM === "dumb") return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(opts.tty) && !opts.noColor;
};

const esc = String.fromCharCode(27);
const bel = String.fromCharCode(7);

const ansi = (code: string, s: string, on: boolean): string =>
	on ? `${esc}[${code}m${s}${esc}[0m` : s;

/** §12 cell width fn: OSC 8 URLs and SGR escapes are zero-width; glyphs
 *  count as the single codepoint they are. */
export const cellWidth = (s: string): number =>
	[
		...s
			.replace(new RegExp(`${esc}]8;[^${bel}]*${bel}`, "g"), "")
			.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), ""),
	].length;

const padCell = (s: string, w: number, right = false): string => {
	const gap = Math.max(0, w - cellWidth(s));
	return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};

/** §6 narrow default: a column whose cells are ALL empty hides; --wide
 *  shows everything. Empty = the —/- placeholder, never a measured 0. */
const emptyCell = (v: string): boolean => v === "—" || v === "-" || v === "";

interface Col {
	header: string;
	/** false = right-aligned numeric */
	left?: boolean;
	/** §6 only shown with --wide */
	wide?: boolean;
	cell: (i: ReportItem) => string;
}

/** TASK ellipsis: TASK_CAP includes the … (§12). */
export const truncateTask = (t: string): string =>
	[...t].length <= TASK_CAP ? t : `${[...t].slice(0, TASK_CAP - 1).join("")}…`;

const UNKNOWN = "—"; // §5 — unreported, never a measured 0

const tokensCell = (i: ReportItem): string => {
	const v = i.usage["gen_ai.usage.input_tokens"];
	return v == null ? UNKNOWN : compactTokens(v);
};

const cacheCell = (i: ReportItem): string => {
	if (i.cache_share == null) return UNKNOWN;
	return `${Math.round(i.cache_share * 100)}%${i.blind_cache ? CACHE_MARK : ""}`;
};

const outMinCell = (i: ReportItem): string => {
	const out = i.usage["gen_ai.usage.output_tokens"];
	if (out == null || i.age_ms == null || i.age_ms === 0) return UNKNOWN;
	return `${Math.round(out / (i.age_ms / 60_000))}`;
};

const agoCell = (ms: number | null): string =>
	ms == null ? UNKNOWN : agentClock(ms);

const modelCell = (i: ReportItem): string =>
	i.model ? (i.hub ? `${i.model}@${i.hub}` : i.model) : UNKNOWN;

/** Narrow-default column set; §6 --wide unhides the wide-only ones (REQ,
 *  EFFORT, CONSULT) whose empty-on-every-row form the footer summary. */
const COLUMNS: Col[] = [
	{ header: "ITEM", left: true, cell: (i) => i.id },
	{ header: "ST", left: true, cell: (i) => i.glyph },
	{ header: "TASK", left: true, cell: (i) => truncateTask(i.title) },
	{ header: "TOKENS", cell: tokensCell },
	{ header: "CACHE", cell: cacheCell },
	{ header: "OUT/MIN", cell: outMinCell },
	{ header: "AGE", cell: (i) => agoCell(i.age_ms) },
	{ header: "LAST", cell: (i) => agoCell(i.last_activity_ms_ago) },
	{ header: "MODEL", cell: modelCell },
	{
		header: "REQ",
		wide: true,
		cell: (i) => (i.requests == null ? UNKNOWN : `${i.requests}`),
	},
	{ header: "EFFORT", wide: true, cell: (i) => i.effort ?? UNKNOWN },
	{ header: "CONSULT", wide: true, cell: (i) => (i.consult ? "Y" : "N") },
];

/** §4 section display labels — shared by every mode renderer. */
export const SECTION_LABEL: Record<string, string> = {
	needs_you: "needs you",
	working: "working",
	waiting: "waiting",
	done: "recent done",
};

export interface RenderOpts {
	format: ReportFormat;
	/** colour decision already resolved (colorEnabled) */
	color?: boolean;
	/** §2 tty only: wrap ITEM ids in OSC 8 deep-links */
	links?: boolean;
	/** §6 show wide-only columns */
	wide?: boolean;
}

/** The §4 tty table: ONE table, section header lines between groups, global
 *  widths from the §12 cell fn; footer carries totals + the §6 summary. */
export const renderTty = (c: ReportContract, o: RenderOpts): string => {
	const cols = COLUMNS.filter((col) => Boolean(o.wide) || !col.wide);
	// §6: narrow default hides columns empty on EVERY row; --wide shows all
	// (the brief's "wide shows all" — empties render as — placeholders).
	const shown = o.wide
		? cols
		: cols.filter((col) => c.items.some((i) => !emptyCell(col.cell(i))));
	const hidden = cols.filter((col) => !shown.includes(col));
	const widths = shown.map((col) =>
		Math.max(col.header.length, ...c.items.map((i) => cellWidth(col.cell(i)))),
	);
	const row = (i: ReportItem): string =>
		shown
			.map((col, x) => {
				let v = col.cell(i);
				if (col.header === "ITEM" && o.links) v = osc8Link(v, i.links.task);
				return padCell(v, widths[x] ?? 0, !col.left);
			})
			.join("  ")
			.replace(/\s+$/, "");
	const lines: string[] = [
		shown
			.map((col, x) => padCell(col.header, widths[x] ?? 0, !col.left))
			.join("  ")
			.replace(/\s+$/, ""),
		shown.map((_col, x) => "-".repeat(widths[x] ?? 1)).join("  "),
	];
	let prev = "";
	for (const i of c.items) {
		if (i.section !== prev) {
			prev = i.section;
			lines.push(
				ansi(
					"2",
					`${SECTION_LABEL[i.section]} (${c.items.filter((x) => x.section === prev).length})`,
					Boolean(o.color),
				),
			);
		}
		lines.push(row(i));
	}
	if (c.items.some((i) => i.blind_cache)) lines.push(CACHE_LEGEND);
	lines.push(footerLine(c, hidden));
	return lines.join("\n");
};

/** §6/§7 footer: totals, lanes per hub, and the hidden-column summary. */
export const footerLine = (c: ReportContract, hidden: Col[]): string => {
	const bits = [
		`tokens ${compactTokens(c.totals.input_tokens)}`,
		`out ${compactTokens(c.totals.output_tokens)}`,
		`cache saved ${compactTokens(c.totals.cache_read_tokens)}`,
	];
	const hubs = Object.entries(c.totals.lanes_per_hub);
	if (hubs.length) bits.push(hubs.map(([h, n]) => `${h}×${n}`).join(" "));
	if (c.footer.lanes_other_projects)
		bits.push(`+${c.footer.lanes_other_projects} in other repos`);
	if (hidden.length)
		bits.push(`hidden: ${hidden.map((h) => h.header).join("/")}`);
	return bits.join(" · ");
};

/** §2 md: a markdown list, links OUTSIDE code fences, glyph + word. */
export const renderMd = (c: ReportContract): string => {
	const lines: string[] = [];
	let prev = "";
	for (const i of c.items) {
		if (i.section !== prev) {
			prev = i.section;
			lines.push(
				`**${SECTION_LABEL[prev]} (${c.items.filter((x) => x.section === prev).length})**`,
			);
		}
		const bits = [
			`[${i.id}](${i.links.task})`,
			`${i.glyph} ${i.status}`,
			`age ${agoCell(i.age_ms)}`,
		];
		if (i.model) bits.push(i.hub ? `${i.model}@${i.hub}` : i.model);
		lines.push(`- ${bits.join(" · ")} — ${truncateTask(i.title)}`);
	}
	return lines.join("\n");
};

/** §2 plain: TSV for pipes — no escapes, no colour, header row first. */
export const renderPlain = (c: ReportContract): string => {
	const cols = COLUMNS.filter((col) => !col.wide);
	const esc = (v: string): string => v.replace(/\t/g, " ");
	const head = cols.map((col) => esc(col.header)).join("\t");
	const rows = c.items.map((i) =>
		cols.map((col) => esc(col.cell(i))).join("\t"),
	);
	return [head, ...rows].join("\n");
};

/** The ONE render dispatch (§2): json = the contract verbatim; tty/md/plain
 *  render from it. Unknown format → null (caller dies loud at the parse
 *  boundary). */
export const renderReport = (
	c: ReportContract,
	o: RenderOpts,
): string | null => {
	switch (o.format) {
		case "json":
			return JSON.stringify(c, null, 2);
		case "md":
			return renderMd(c);
		case "plain":
			return renderPlain(c);
		case "tty":
			return renderTty(c, o);
		default:
			return null;
	}
};

/** W892-compat face: rows → tty table text (scripts/lib/fleet-report.ts and
 *  the work.ts verb keep their call shape; §6 narrow default, §12 fixes). */
export const buildReportTable = (
	rows: ReportRow[],
	opts: { links?: boolean; baseUrl?: string; wide?: boolean } = {},
): string => {
	const base = opts.baseUrl ?? reportBoardBase();
	const c = buildReportContract(rows, { project: "", boardBase: base });
	return renderTty(c, { format: "tty", links: opts.links, wide: opts.wide });
};
