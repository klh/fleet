// hooks/lib/usage/report-savings.ts — W894: mother-clone efficiency + optimization
// savings behind the supervisor report's CLONE/SAVED columns (the W892 table
// adopts these; footer renders when width-constrained). Sources, all
// injectable, leaf-pure:
//   clone    — the dispatch registry's lane logs (${fleet}/lane-<sid>.log):
//              the STARTER line dispatch appends at spawn (scripts/lib/
//              lane-starter.ts starterStartLine) says forked starter <sha>
//              (cached|seeded) vs cold start.
//   usage    — buckle's per-lane cache log (${BUCKLE_DB}.lane-cache.jsonl,
//              W458.4 NDJSON rows) via cache-telemetry's tolerant reader.
//   condense — board stage telemetry: orch.ts records a content-free
//              `for:"prompt.stages"` llm.call event per orchestrate round
//              with the stage byte counts; Σ(original − condensed)/4 ≈ tok.
// Baseline (owner definition, 2026-10-19): a COLD lane = no starter, no
// condense, no cache — every input token fresh. saved = cache_read +
// starter-fork orientation tokens + condense shrink;
// pct = saved / (fresh_in + saved) vs that cold-raw baseline.
// Per-lane condense has no durable sid key yet (the held plan is TTL'd), so
// condense savings aggregate into the fleet-day footer only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CacheRow, readLaneCacheLog } from "./cache-telemetry.ts";

/** Per-fork fresh-input tokens the warm starter context avoids re-reading —
 *  the 2026-10-07 bench mean delta (fresh 10 432 → 1 100 tok,
 *  packages/suspenders/docs/lane-starters.md). The W768 adoption median
 *  (49 752 → 371) is doc-flagged wander-skewed; the conservative mean is
 *  the anchor. A doc-sourced estimate like STARTER_SAVED_S, never a live
 *  per-lane measurement. */
export const STARTER_SAVED_TOKENS = 9_332;

/** ≈ bytes per token for byte→token conversion (English prose). */
export const BYTES_PER_TOKEN = 4;

export type StarterEvidence =
	| {
			mode: "fork";
			version: string;
			source: "cached" | "seeded";
			session: string;
			savedS: number;
	  }
	| { mode: "cold"; reason: string };

/** First STARTER line of the lane's dispatch log → evidence; null when the
 *  lane was never dispatch-spawned (manual take) or the log is gone. */
export function readStarterEvidence(
	fleet: string,
	sid: string,
): StarterEvidence | null {
	const file = join(fleet, `lane-${sid}.log`);
	if (!existsSync(file)) return null;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const fork = line.match(
			/^STARTER \S+ — forked starter (\S+) \((cached|seeded), session ([^;)]+)(?:, seed [\d.]+s)?; saved ≈([\d.]+)s/,
		);
		if (fork)
			return {
				mode: "fork",
				version: fork[1],
				source: fork[2] as "cached" | "seeded",
				session: fork[3],
				savedS: Number(fork[4]),
			};
		const cold = line.match(/^STARTER \S+ — cold start \((.+)\)$/);
		if (cold) return { mode: "cold", reason: cold[1] };
	}
	return null;
}

/** Σ usage per lane from lane-cache rows (the metrics series). */
export interface LaneUsage {
	in: number;
	cacheR: number;
	cacheC: number;
	out: number;
	requests: number;
}

export function laneUsageTotals(rows: CacheRow[]): Map<string, LaneUsage> {
	const out = new Map<string, LaneUsage>();
	for (const r of rows) {
		const u = out.get(r.lane) ?? {
			in: 0,
			cacheR: 0,
			cacheC: 0,
			out: 0,
			requests: 0,
		};
		u.in += r.usage.in_tok;
		u.cacheR += r.usage.cache_r;
		u.cacheC += r.usage.cache_c;
		u.out += r.usage.out_tok;
		u.requests += r.requests;
		out.set(r.lane, u);
	}
	return out;
}

/** saved/coldRaw/pct for one lane given its evidence. */
export function savingsFor(
	usage: LaneUsage | undefined,
	parts: { starterFork?: boolean; condenseBytes?: number | null },
): { savedTok: number; coldRaw: number; pct: number | null } {
	const condenseTok = Math.max(
		0,
		Math.round((parts.condenseBytes ?? 0) / BYTES_PER_TOKEN),
	);
	const saved =
		(usage?.cacheR ?? 0) +
		(parts.starterFork ? STARTER_SAVED_TOKENS : 0) +
		condenseTok;
	const coldRaw = (usage?.in ?? 0) + saved;
	const pct = coldRaw > 0 ? Math.round((saved / coldRaw) * 100) : null;
	return { savedTok: saved, coldRaw, pct };
}

/** Compact token render: 933 / 12.3k / 4.1M. */
export const fmtTok = (n: number): string =>
	Math.abs(n) >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M`
		: Math.abs(n) >= 1_000
			? `${(n / 1_000).toFixed(1)}k`
			: `${n}`;

/** CLONE column: `fork 60s` (starter fork + spawn-time saved) / `cold` /
 *  `-` (never dispatch-spawned — manual take). */
export const cloneCell = (e: StarterEvidence | null): string =>
	e === null
		? "-"
		: e.mode === "fork"
			? `fork ${Math.round(e.savedS)}s`
			: "cold";

/** SAVED column cell: `~34.1M (~97%)` or `-` when nothing measurable. */
export const savedCell = (r: {
	savedTok: number;
	pct: number | null;
}): string => (r.savedTok === 0 ? "-" : `~${fmtTok(r.savedTok)} (~${r.pct}%)`);

/** One table row's two columns, given the item's owning sid. */
export function itemSavingsRow(
	sid: string | null,
	usageByLane: Map<string, LaneUsage>,
	fleet: string,
): { clone: string; saved: string; savedTok: number; pct: number | null } {
	const ev = sid ? readStarterEvidence(fleet, sid) : null;
	const r = savingsFor(sid ? usageByLane.get(sid) : undefined, {
		starterFork: ev?.mode === "fork",
	});
	return { clone: cloneCell(ev), saved: savedCell(r), ...r };
}

/** Structural db face for the stage-event reader (bun:sqlite compatible). */
export interface StageEventDb {
	query(sql: string): { all(...args: unknown[]): unknown[] };
}

/** Condense stage events since sinceMs → per-round (original, condensed)
 *  byte pairs; unparseable payloads are skipped, never fabricated. */
export function condenseStageEvents(
	db: StageEventDb,
	sinceMs: number,
): Array<{ originalBytes: number; condensedBytes: number | null }> {
	const rows = db
		.query(
			"SELECT payload FROM events WHERE source = 'orchestrate' AND kind = 'llm.call' AND ts >= ?",
		)
		.all(sinceMs) as Array<{ payload?: unknown }>;
	const out: Array<{ originalBytes: number; condensedBytes: number | null }> =
		[];
	for (const r of rows) {
		if (typeof r.payload !== "string") continue;
		try {
			const p = JSON.parse(r.payload) as {
				for?: unknown;
				originalBytes?: unknown;
				condensedBytes?: unknown;
			};
			if (p.for !== "prompt.stages") continue;
			out.push({
				originalBytes:
					typeof p.originalBytes === "number" ? p.originalBytes : 0,
				condensedBytes:
					typeof p.condensedBytes === "number" ? p.condensedBytes : null,
			});
		} catch {
			// damaged payload — skipped
		}
	}
	return out;
}

/** UTC-midnight start of the day containing nowMs. */
export function fleetDayStartMs(nowMs = Date.now()): number {
	const d = new Date(nowMs);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Fleet-day aggregate: usage + starter evidence for every lane seen today,
 *  plus the day's condense shrink. */
export function fleetDaySavings(opts: {
	rows: CacheRow[];
	fleet: string;
	dayStartMs: number;
	stageDb?: StageEventDb;
}): {
	lanes: number;
	forks: number;
	savedTok: number;
	coldRaw: number;
	pct: number | null;
} {
	const today = opts.rows.filter((r) => {
		const t = Date.parse(r.at);
		return !Number.isNaN(t) && t >= opts.dayStartMs;
	});
	const byLane = laneUsageTotals(today);
	let forks = 0;
	let saved = 0;
	let coldRaw = 0;
	for (const [sid, u] of byLane) {
		const ev = readStarterEvidence(opts.fleet, sid);
		const fork = ev?.mode === "fork";
		if (fork) forks++;
		const r = savingsFor(u, { starterFork: fork });
		saved += r.savedTok;
		coldRaw += r.coldRaw;
	}
	if (opts.stageDb) {
		for (const s of condenseStageEvents(opts.stageDb, opts.dayStartMs)) {
			if (s.condensedBytes === null) continue;
			const tok = Math.max(
				0,
				Math.round((s.originalBytes - s.condensedBytes) / BYTES_PER_TOKEN),
			);
			saved += tok;
			coldRaw += tok;
		}
	}
	const pct = coldRaw > 0 ? Math.round((saved / coldRaw) * 100) : null;
	return { lanes: byLane.size, forks, savedTok: saved, coldRaw, pct };
}

/** Width-constrained fallback: the whole day in one footer line. */
export const savingsFooter = (d: {
	lanes: number;
	forks: number;
	savedTok: number;
	pct: number | null;
}): string =>
	`SAVED fleet-day ~${fmtTok(d.savedTok)} tok (~${d.pct ?? "-"}% vs cold-raw baseline, ${d.lanes} lanes, ${d.forks} forks)`;
