// hooks/lib/lanes/lane-backfill.ts — W2059 attribution backfill. Controller-
// closed and interactively-executed items render MODEL/TOKENS/CACHE dashes in
// the report because the W776 join only matches per-lane minted keys
// (api_keys.name = lane sid): an interactive session's traffic rides the
// machine's shared interactive key, so NO ledger row ever carries the session
// sid. The backfill links the closer session's keys — its sid-named key (when
// one exists) plus the machine's interactive key names
// (SUSPENDERS_INTERACTIVE_KEYS comma-set, default "claude-cli-interactive") —
// over the item's FINAL claim window (last claim → work.done): in-time
// overlap, not causality (the W635 honesty rule). Constraint honored: rows
// already attributed to a lane sid are a DISJOINT key set — never summed
// here, never double-counted. A window with zero rows stays null — the
// honest '-', never invented attribution for a session that made zero calls.
import { Database } from "bun:sqlite";
import type { GroupSpend } from "./lane-spend.ts";
import type { TimingEventRow } from "../work/work-timing.ts";
import { claimWindows } from "../work/work-timing.ts";

export interface BackfillSpend {
	fresh: number;
	cached: number;
	out: number;
	requests: number;
	groups: Record<string, GroupSpend>;
}

/** The additive attribution event: payload {work, backfill, sid, from, to}.
 *  Emitted by `work done` (auto-stamp, fail-soft) and `work backfill`
 *  (already-closed items). itemAttribution replays it, LAST event wins. */
export const BACKFILL_EVENT = "work.attribution";

/** Machine-conf knob: comma-set interactive key names. */
export const interactiveKeyNames = (): string[] =>
	(process.env.SUSPENDERS_INTERACTIVE_KEYS ?? "claude-cli-interactive")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/** The closer session's ledger keys: the sid-named key plus interactive keys. */
export const closerKeyNames = (sid: string): string[] => [
	...new Set([sid, ...interactiveKeyNames()]),
];

const isoBucket = (ms: number): string =>
	`${new Date(ms).toISOString().slice(0, 13)}:00`;

/** Sum the closer's router_usage rows over the window [fromMs, toMs). An
 *  hour bucket attributes when its interval [start, start+1h) intersects the
 *  window (the lane-spend bucket rule). Null when the window attributes
 *  nothing — the honest '-', never invented data. */
export function backfillSpend(
	ledgerPath: string,
	sid: string,
	fromMs: number,
	toMs: number,
): BackfillSpend | null {
	if (!(toMs > fromMs) || !sid) return null;
	let d: Database;
	try {
		d = new Database(ledgerPath, { readonly: true });
	} catch {
		return null;
	}
	try {
		const names = closerKeyNames(sid);
		const ph = names.map(() => "?").join(",");
		// generous string bounds; the exact interval filter runs in JS below
		const lower = isoBucket(fromMs - 3_600_000);
		const upper = `${isoBucket(toMs)}~`; // sorts past any "HH:00" bucket
		const rows = d
			.query(
				`SELECT ru.hour_bucket b, ru.model_group g, SUM(ru.in_tok) i,
				  SUM(ru.out_tok) o, SUM(ru.cache_r) cr, SUM(ru.cache_c) cc,
				  SUM(ru.requests) q
				 FROM router_usage ru JOIN api_keys ak ON ak.key_id = ru.key
				 WHERE ak.name IN (${ph}) AND ru.hour_bucket >= ? AND ru.hour_bucket < ?
				 GROUP BY ru.hour_bucket, ru.model_group`,
			)
			.all(...names, lower, upper) as Array<Record<string, unknown>>;
		const t = { fresh: 0, cached: 0, out: 0, requests: 0 };
		const groups: Record<string, GroupSpend> = {};
		for (const r of rows) {
			const start = Date.parse(`${String(r.b)}:00Z`);
			if (
				!Number.isFinite(start) ||
				start + 3_600_000 <= fromMs ||
				start >= toMs
			)
				continue;
			const i = Number(r.i);
			const o = Number(r.o);
			const cr = Number(r.cr);
			const cc = Number(r.cc);
			t.fresh += i;
			t.out += o;
			t.cached += cr + cc;
			t.requests += Number(r.q);
			const g = groups[String(r.g)] ?? {
				in: 0,
				out: 0,
				cacheR: 0,
				cacheC: 0,
				requests: 0,
			};
			groups[String(r.g)] = {
				in: g.in + i,
				out: g.out + o,
				cacheR: g.cacheR + cr,
				cacheC: g.cacheC + cc,
				requests: g.requests + Number(r.q),
			};
		}
		if (t.fresh + t.cached + t.out <= 0) return null;
		return { ...t, groups };
	} finally {
		d.close();
	}
}

/** Replay work.attribution events for one project → per-item BackfillSpend
 *  (last event wins). Same project filter as the W15 timing replay. */
export function attributionBackfills(
	db: Database,
	project: string,
	pre?: TimingEventRow[],
): Map<string, BackfillSpend> {
	const rows = pre
		? pre.filter((r) => r.kind === BACKFILL_EVENT && r.project === project)
		: (db
				.query(
					"SELECT project, id, ts, kind, payload FROM events WHERE kind = ? AND project = ? ORDER BY ts, id",
				)
				.all(BACKFILL_EVENT, project) as TimingEventRow[]);
	const out = new Map<string, BackfillSpend>();
	for (const r of rows) {
		let p: { work?: string; backfill?: string } = {};
		try {
			p = JSON.parse(r.payload ?? "{}") as {
				work?: string;
				backfill?: string;
			};
		} catch {
			continue; // garbage payload → skip
		}
		if (!p.work || !p.backfill) continue;
		try {
			out.set(p.work, JSON.parse(p.backfill) as BackfillSpend);
		} catch {
			// garbage stamp → keep the prior stamp
		}
	}
	return out;
}

/** Compute one item's close-window backfill (final claim window via the
 *  claim replay, closer keys via the ledger). Null = nothing to stamp —
 *  fail-soft on an unreadable ledger. */
export function backfillForItem(
	db: Database,
	project: string,
	work: string,
	sid: string,
	ledgerPath: string | null,
	nowMs = Date.now(),
): BackfillSpend | null {
	try {
		const { windows } = claimWindows(db, project, nowMs);
		const ws = windows.get(work) ?? [];
		const last = ws[ws.length - 1];
		if (!last) return null;
		const end = last.end || nowMs;
		return backfillSpend(ledgerPath ?? "", sid, last.start, end);
	} catch {
		return null;
	}
}
