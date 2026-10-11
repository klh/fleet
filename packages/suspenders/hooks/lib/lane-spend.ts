// hooks/lib/lane-spend.ts — W635 cost-per-DONE-item. Joins the buckle
// ledger's router_usage (hour-bucket token rollup keyed by API key id) to
// work-graph claim windows: api_keys.name for a per-lane minted key is the
// lane sid (dispatch mints name=sid, scope buckle:proxy:WRITE_), so
// router_usage ⋈ api_keys gives per-lane spend, and claimWindows gives
// per-item attribution. Same honesty rules as W24 tokenUsage: attribution is
// claim-window overlap in time, not causality; a missing or unreadable
// ledger fails soft (no cost section — metrics never blocks on the gateway).
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { ClaimWindow } from "./work-timing.ts";

/** One hour-bucket spend row from the buckle ledger. */
export interface LaneSpendRow {
	bucket: string; // "YYYY-MM-DDTHH:00" UTC (toISOString().slice(0,13)+":00")
	sid: string; // api_keys.name = lane sid (per-lane minted keys)
	group: string; // router_usage.model_group — the class dimension
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
	requests: number;
}

/** Per-item attributed spend with its per-class (model_group) split. */
export interface ItemSpend {
	work: string;
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
	requests: number;
	groups: Map<
		string,
		{
			in: number;
			out: number;
			cacheR: number;
			cacheC: number;
			requests: number;
		}
	>;
}

/** Resolve the buckle ledger path: SUSPENDERS_BUCKLE_DB env pin, then the
 *  documented spoke home. Config-over-code — only channel names, no paths
 *  beyond the documented spoke layout. null = no readable ledger. */
export function resolveBuckleDb(home = process.env.HOME ?? ""): string | null {
	const env = process.env.SUSPENDERS_BUCKLE_DB;
	if (env && existsSync(env)) return env;
	const spoke = home ? `${home}/.claude/local-llm/buckle.db` : "";
	return spoke && existsSync(spoke) ? spoke : null;
}

/** Per-lane, per-hour, per-model_group token spend from the buckle ledger.
 *  `fromBucket` is a "YYYY-MM-DDTHH:00" UTC lower bound (lexicographic). */
export function laneSpendRows(
	dbPath: string,
	fromBucket: string,
): LaneSpendRow[] {
	const d = new Database(dbPath, { readonly: true });
	try {
		const rows = d
			.query(
				`SELECT ru.hour_bucket AS bucket, ak.name AS sid, ru.model_group AS grp,
				  SUM(ru.in_tok) AS i, SUM(ru.out_tok) AS o,
				  SUM(ru.cache_r) AS cr, SUM(ru.cache_c) AS cc, SUM(ru.requests) AS req
				 FROM router_usage ru JOIN api_keys ak ON ak.key_id = ru.key
				 WHERE ru.hour_bucket >= ?
				 GROUP BY ru.hour_bucket, ak.name, ru.model_group
				 ORDER BY ru.hour_bucket`,
			)
			.all(fromBucket) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			bucket: String(r.bucket),
			sid: String(r.sid),
			group: String(r.grp),
			inTok: Number(r.i),
			outTok: Number(r.o),
			cacheR: Number(r.cr),
			cacheC: Number(r.cc),
			requests: Number(r.req),
		}));
	} finally {
		d.close();
	}
}

/** Attribute lane spend to items via claim windows. A bucket overlaps a
 *  window when the bucket's HOUR INTERVAL [start, start+1h) intersects
 *  [window.start, window.end) — partial-hour buckets attribute to the
 *  overlapping window, so sub-hour claims never lose their spend. Each
 *  bucket attributes ONCE per item (first matching window — hour buckets
 *  can straddle sequential re-claims; summing would double-count). Spend
 *  on lanes with no matching claim window is never attributed. */
export function itemSpend(
	rows: LaneSpendRow[],
	windows: Map<string, ClaimWindow[]>,
): Map<string, ItemSpend> {
	const bySid = new Map<string, LaneSpendRow[]>();
	for (const r of rows) {
		const arr = bySid.get(r.sid);
		if (arr) arr.push(r);
		else bySid.set(r.sid, [r]);
	}
	const attributed = new Set<LaneSpendRow>();
	const out = new Map<string, ItemSpend>();
	for (const [work, ws] of windows) {
		const t: ItemSpend = {
			work,
			in: 0,
			out: 0,
			cacheR: 0,
			cacheC: 0,
			requests: 0,
			groups: new Map(),
		};
		for (const w of ws) {
			const rs = bySid.get(w.sid);
			if (!rs) continue;
			for (const r of rs) {
				const start = Date.parse(`${r.bucket}:00Z`);
				if (
					!Number.isFinite(start) ||
					start + 3_600_000 <= w.start ||
					start >= w.end
				)
					continue;
				if (attributed.has(r)) continue; // once per (item, bucket, sid)
				t.in += r.inTok;
				t.out += r.outTok;
				t.cacheR += r.cacheR;
				t.cacheC += r.cacheC;
				t.requests += r.requests;
				const g =
					t.groups.get(r.group) ??
					({
						in: 0,
						out: 0,
						cacheR: 0,
						cacheC: 0,
						requests: 0,
					} as const);
				t.groups.set(r.group, {
					in: g.in + r.inTok,
					out: g.out + r.outTok,
					cacheR: g.cacheR + r.cacheR,
					cacheC: g.cacheC + r.cacheC,
					requests: g.requests + r.requests,
				});
				attributed.add(r);
			}
		}
		out.set(work, t);
	}
	return out;
}
