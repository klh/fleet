// work-report.ts — W892: `work report`, the ONE supervisor reply table
// (owner GO 2026-10-19). Port of the coordinator's prototype loop: rows =
// riding + queued + recent-done items (or --ids), columns ITEM/ST/TASK/
// TOKENS/CACHE/OUT-MIN/AGENT computed from each item's W776 attribution
// (fresh+cached tokens, cache-hit %, out/min over agent wall). Programmatic
// fixed-width pads — the table cannot drift. ST letters: R = riding
// (CLAIMED/RUNNING), Q = queued (READY), D = done (DONE), F = failed
// (FAILED; surfaces via --ids). W891 colors these letters on the board.

import type { Database } from "bun:sqlite";
import {
	type GroupSpend,
	type ItemAttribution,
	itemAttribution,
} from "./lane-spend.ts";

/** One table row: graph state joined to its spend attribution. */
export interface ReportRow {
	id: string;
	state: string;
	title: string;
	fresh: number;
	cached: number;
	out: number;
	agentMs: number;
	model: string; // W909: top model_group (+ when several), "" = none
	effort: string | null; // W909: lane effort level (work.done payload)
	consulted: boolean; // W909: lane banked knowledge or consulted
}

/** done → D, failed → F, riding (CLAIMED/RUNNING) → R, queued (READY) → Q. */
export const reportLetter = (state: string): string => {
	if (state === "DONE") return "D";
	if (state === "FAILED") return "F";
	if (state === "READY") return "Q";
	return "R"; // CLAIMED/RUNNING — riding
};

/** --done-window duration: `45m | 2h | 2d` (s/m/h/d), capped at 30d. */
export const parseReportWindow = (raw: string): number | null => {
	const m = /^(\d+)([smhd])$/.exec(raw);
	if (!m) return null;
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
		m[2] as "s" | "m" | "h" | "d"
	];
	const ms = Number(m[1]) * unit;
	return ms <= 0 || ms > 30 * 86_400_000 ? null : ms;
};

/** Recent-done lookback default: DONE rows older than this leave the table. */
export const DEFAULT_DONE_WINDOW_MS = 48 * 3_600_000;

/** Recent-done row cap: the table carries the LAST few done, never the flood. */
export const DONE_ROW_CAP = 5;

/** Compact token count: 1.0M+ → `8.8M`, 10k+ → `172k`, else plain. */
export const compactTokens = (n: number): string =>
	n >= 1e6
		? `${(n / 1e6).toFixed(1)}M`
		: n >= 1e4
			? `${Math.round(n / 1e3)}k`
			: `${n}`;

/** Agent wall clock: `12m`, `1h56m`, `21h37m`, `9d22h`; minutes drop above a day. */
export const agentClock = (ms: number): string => {
	const m = Math.round(ms / 60_000);
	if (m >= 1440)
		return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
	if (m >= 60)
		return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
	return `${m}m`;
};

/** W909 MODEL cell: the top model_group by attributed tokens (ties break by
 *  name), truncated at MODEL_CAP, "+" appended when several groups carry
 *  spend; "" when none. */
export const MODEL_CAP = 16;
export const reportModel = (groups: Record<string, GroupSpend>): string => {
	const ranked = Object.entries(groups)
		.map(([g, s]) => [g, s.in + s.out + s.cacheR + s.cacheC] as const)
		.filter(([, t]) => t > 0)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	if (!ranked.length) return "";
	return ranked[0][0].slice(0, MODEL_CAP) + (ranked.length > 1 ? "+" : "");
};

/** W909 CONSULT set: items whose lane banked knowledge (knowledge.enqueued)
 *  or consulted (consult / consult.answer) — W909 stamps work+project into
 *  those event payloads at record time; pre-W909 events carry no link and
 *  honestly read N. */
export const consultedItems = (
	db: Database,
	project: string,
): Set<string> => {
	try {
		const rows = db
			.query(
				"SELECT payload FROM events WHERE kind IN ('consult','consult.answer','knowledge.enqueued') AND project = ?",
			)
			.all(project) as { payload: string | null }[];
		const out = new Set<string>();
		for (const r of rows) {
			try {
				const w = (
					JSON.parse(r.payload ?? "{}") as { work?: string }
				).work;
				if (w) out.add(w);
			} catch {}
		}
		return out;
	} catch {
		return new Set(); // no events table (tests) — fail soft
	}
};

/** W892 row mapper: graph items ⋈ W776 attribution → table rows. */
export const toReportRows = (
	items: Array<Record<string, string | number | null>>,
	attribution: Map<string, ItemAttribution>,
	consulted?: Set<string>,
): ReportRow[] =>
	items.map((it) => {
		const a = attribution.get(String(it.id));
		return {
			id: String(it.id),
			state: String(it.state),
			title: String(it.title ?? ""),
			fresh: a?.fresh ?? 0,
			cached: a?.cached ?? 0,
			out: a?.out ?? 0,
			agentMs: a?.agentMs ?? 0,
			model: reportModel(a?.groups ?? {}),
			effort: a?.effort ?? null,
			consulted: consulted?.has(String(it.id)) ?? false,
		};
	});

/** A work_items row, loosely typed (the graph table's shape). */
type Item = Record<string, string | number | null>;

/** Table rows: `--ids` resolve strictly (misses land in `missing` — the
 *  caller dies loud, never a silent skip); otherwise riding + queued +
 *  done-within-window, most recently touched first. */
export const reportRows = (
	db: Database,
	project: string,
	opts: {
		ids?: string[];
		doneWindowMs?: number;
		now?: number;
		/** hermetic pin (tests): null = zero spend, real wall */
		ledger?: string | null;
	},
): { rows: ReportRow[]; missing: string[] } => {
	const now = opts.now ?? Date.now();
	const window = opts.doneWindowMs ?? DEFAULT_DONE_WINDOW_MS;
	const q = db.query("SELECT * FROM work_items WHERE project = ? AND id = ?");
	let items: Item[] = [];
	const missing: string[] = [];
	if (opts.ids && opts.ids.length > 0) {
		for (const id of opts.ids) {
			const r = q.get(project, id) as Item | null;
			if (r) items.push(r);
			else missing.push(id);
		}
	} else {
		const actives = db
			.query(
				`SELECT * FROM work_items WHERE project = ?
				 AND state IN ('CLAIMED','RUNNING','READY')
				 ORDER BY updated_at DESC`,
			)
			.all(project) as Item[];
		// "recent-done" = the last few finished, bounded both ways: at most
		// DONE_ROW_CAP rows inside the lookback window (a busy fleet closes
		// hundreds per day — an unbounded window floods the supervisor reply).
		const dones = db
			.query(
				`SELECT * FROM work_items WHERE project = ?
				 AND state = 'DONE' AND updated_at >= ?
				 ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(project, now - window, DONE_ROW_CAP) as Item[];
		items = [...actives, ...dones].sort(
			(a, b) => Number(b.updated_at) - Number(a.updated_at),
		);
	}
	return {
		rows: toReportRows(
			items,
			itemAttribution(
				db,
				project,
				now,
				"ledger" in opts ? opts.ledger : undefined,
			),
			consultedItems(db, project),
		),
		missing,
	};
};

const COLUMNS = [
	"ITEM",
	"ST",
	"TASK",
	"TOKENS",
	"CACHE",
	"OUT/MIN",
	"AGENT",
	"MODEL",
	"EFFORT",
	"CONSULT",
];

/** TASK truncation cap from the coordinator prototype (no ellipsis). */
export const TASK_CAP = 26;

/** The prototype table (W892): fixed-width programmatic pads — ITEM/ST/TASK
 *  left, the rest (numeric + MODEL/EFFORT/CONSULT, W909) right; separator =
 *  per-column dashes. Zero-spend rows show `-` for TOKENS/CACHE and 0 for
 *  OUT/MIN; no data = `-` for MODEL/EFFORT and N for CONSULT. */
export const buildReportTable = (rows: ReportRow[]): string => {
	const cells = rows.map((r) => {
		const tokens = r.fresh + r.cached;
		return [
			r.id,
			reportLetter(r.state),
			r.title.slice(0, TASK_CAP),
			tokens > 0 ? compactTokens(tokens) : "-",
			tokens > 0 ? `${Math.round((r.cached / tokens) * 100)}%` : "-",
			`${r.agentMs > 0 ? Math.round(r.out / (r.agentMs / 60_000)) : 0}`,
			agentClock(r.agentMs),
			r.model || "-",
			r.effort ?? "-",
			r.consulted ? "Y" : "N",
		];
	});
	const widths = COLUMNS.map((h, c) =>
		Math.max(h.length, ...cells.map((row) => row[c].length)),
	);
	const line = (cols: string[]): string =>
		cells &&
		cols
			.map((v, c) => (c <= 2 ? v.padEnd(widths[c]) : v.padStart(widths[c])))
			.join("  ");
	const head = COLUMNS.map((h, c) =>
		c <= 2 ? h.padEnd(widths[c]) : h.padStart(widths[c]),
	).join("  ");
	const sep = widths.map((w) => "-".repeat(w)).join("  ");
	return [head, sep, ...cells.map((row) => line(row))].join("\n");
};
