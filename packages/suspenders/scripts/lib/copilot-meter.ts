// scripts/lib/copilot-meter.ts — W223.2 copilot credit metering. Copilot
// CLI lanes run on metered credits (premium requests; each model carries a
// request multiplier — opus 15x, sonnet 1x on this host's live data), and
// spend must be visible. The machine-readable surface exists: copilot's own
// session store (`~/.copilot/session-store.db`, tables `sessions` +
// `assistant_usage_events`) records per-request usage — model, tokens,
// `total_nano_aiu`, `request_multiplier`, per copilot session with a cwd.
//
// This module: (capture) opens that store READ-ONLY (quota-sweep.ts's
// buckle.db precedent — copilot's store is upstream data, never the fleet
// ledger) and attributes copilot sessions to fleet lanes by worktree-path
// prefix against .fleet/lanes.json (dispatch spawns lanes with cwd = the
// lane worktree, so `sessions.cwd` under `<repo>/.worktrees/<item>` IS the
// lane; resumed lanes reuse the worktree, so spend accumulates across
// attempts). Ambiguity policy: the LONGEST worktree prefix wins; a tie
// (two lanes sharing one worktree) attributes to the newest-launched lane.
//
// (accumulate) per-lane totals land in governor.db as the fact
// `lane.<sid>.usage` — JSON, upserted — written ONLY through the coord CLI
// verb (`coord fact set`, the supported surface; no raw sqlite on
// governor.db from this module) on the dispatch cadence: dispatch-next's
// main() flushes once per cycle, so the fleet loop (hooks/bin/fleet-loop.ts
// --every) keeps totals fresh without a new daemon.
//
// (surface) `scripts/lanes.ts` and the board's laneModelOf() read the same
// fact back through the coord CLI. Missing store / missing fact are honest
// empties, never fabricated numbers.
import { existsSync, readFileSync } from "node:fs";

export type LaneUsage = {
	sid: string;
	item: string;
	worktree: string;
	credits: number; // SUM(request_multiplier) — premium-request credits
	nanoAiu: number; // SUM(total_nano_aiu)
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheW: number;
	sessions: number; // distinct copilot sessions attributed
	models: string[];
	lastAt: number | null; // newest usage event, ms epoch
};

export type MeterReport = {
	store: string;
	ok: boolean; // false = store missing/unreadable (why says which)
	why?: string;
	lanes: LaneUsage[];
};

export const copilotStorePath = (): string =>
	process.env.COPILOT_STORE_DB ??
	`${process.env.HOME}/.copilot/session-store.db`;

const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

type SessionAgg = {
	id: string;
	cwd: string | null;
	credits: number;
	nanoAiu: number;
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheW: number;
	events: number;
	lastAt: number | null;
};

// one grouped row per copilot session; attribution happens in JS (worktree
// prefix policy), the db only aggregates. Defensive COALESCE — a schema
// drift in copilot's store degrades to zeros/honest-empty, never a throw.
const SESSION_SQL = `
	SELECT s.id AS id, s.cwd AS cwd,
		COALESCE(SUM(e.request_multiplier), 0) AS credits,
		COALESCE(SUM(e.total_nano_aiu), 0) AS nanoAiu,
		COALESCE(SUM(e.input_tokens), 0) AS inTok,
		COALESCE(SUM(e.output_tokens), 0) AS outTok,
		COALESCE(SUM(e.cache_read_tokens), 0) AS cacheR,
		COALESCE(SUM(e.cache_write_tokens), 0) AS cacheW,
		COUNT(e.id) AS events,
		MAX(e.created_at) AS lastAt
	FROM sessions s JOIN assistant_usage_events e ON e.session_id = s.id
	GROUP BY s.id, s.cwd`;

const openStore = (
	path: string,
): {
	sessions: () => SessionAgg[];
	models: () => Array<{ id: string; model: string }>;
	close: () => void;
} => {
	// require-once so the readonly import cost stays off the lanes.ts path
	const { Database } = require("bun:sqlite") as {
		Database: new (
			path: string,
			opts?: { readonly?: boolean },
		) => {
			query: (sql: string) => { all: (...p: unknown[]) => unknown[] };
			close: () => void;
		};
	};
	const db = new Database(path, { readonly: true });
	return {
		sessions: () => db.query(SESSION_SQL).all() as SessionAgg[],
		models: () =>
			db
				.query(
					"SELECT DISTINCT e.session_id AS id, e.model AS model FROM assistant_usage_events e",
				)
				.all() as Array<{ id: string; model: string }>,
		close: () => db.close(),
	};
};

/** Attribute copilot sessions to lanes: longest worktree-prefix match,
 *  newest-launched lane breaks an exact-tie. Returns null for session cwds
 *  under no known lane worktree. */
export const laneOfSession = (
	cwd: string,
	lanes: Array<{
		sid: string;
		item: string;
		worktree: string;
		launchedAt?: number;
	}>,
): { sid: string; item: string; worktree: string } | null => {
	let best: {
		sid: string;
		item: string;
		worktree: string;
		launchedAt?: number;
	} | null = null;
	for (const l of lanes) {
		if (!cwd.startsWith(l.worktree)) continue;
		if (
			best === null ||
			l.worktree.length > best.worktree.length ||
			(l.worktree.length === best.worktree.length &&
				(l.launchedAt ?? 0) > (best.launchedAt ?? 0))
		)
			best = l;
	}
	return best
		? { sid: best.sid, item: best.item, worktree: best.worktree }
		: null;
};

/** Read copilot's session store and total spend per fleet lane. */
export const meterCopilotLanes = (
	fleetDir: string,
	opts: { storeDb?: string } = {},
): MeterReport => {
	const store = opts.storeDb ?? copilotStorePath();
	const empty: MeterReport = {
		store,
		ok: false,
		why: "store missing",
		lanes: [],
	};
	if (!existsSync(store)) return empty;
	let lanesJson: Array<{
		sid: string;
		item: string;
		worktree: string;
		launchedAt?: number;
	}> = [];
	try {
		lanesJson = JSON.parse(
			readFileSync(`${fleetDir}/lanes.json`, "utf8"),
		) as typeof lanesJson;
	} catch {
		return {
			store,
			ok: false,
			why: "lanes.json missing/unreadable",
			lanes: [],
		};
	}
	try {
		const db = openStore(store);
		const rows = db.sessions();
		const modelRows = db.models();
		db.close();
		const bySid = new Map<string, LaneUsage>();
		for (const l of lanesJson)
			bySid.set(l.sid, {
				sid: l.sid,
				item: l.item,
				worktree: l.worktree,
				credits: 0,
				nanoAiu: 0,
				inTok: 0,
				outTok: 0,
				cacheR: 0,
				cacheW: 0,
				sessions: 0,
				models: [],
				lastAt: null,
			});
		// per-session model attribution (session id → lane sid, same prefix rule)
		const modelsBySession = new Map<string, Set<string>>();
		for (const m of modelRows) {
			const lane = laneOfSession(
				rows.find((r) => r.id === m.id)?.cwd ?? "",
				lanesJson,
			);
			if (!lane) continue;
			const set = modelsBySession.get(m.id) ?? new Set<string>();
			set.add(m.model);
			modelsBySession.set(m.id, set);
		}
		for (const r of rows) {
			if (!r.cwd) continue;
			const lane = laneOfSession(r.cwd, lanesJson);
			if (!lane) continue;
			const acc = bySid.get(lane.sid);
			if (!acc) continue;
			acc.credits += num(r.credits);
			acc.nanoAiu += num(r.nanoAiu);
			acc.inTok += num(r.inTok);
			acc.outTok += num(r.outTok);
			acc.cacheR += num(r.cacheR);
			acc.cacheW += num(r.cacheW);
			acc.sessions += 1;
			for (const m of modelsBySession.get(r.id) ?? []) acc.models.push(m);
			const lastMs = r.lastAt ? Date.parse(r.lastAt) : Number.NaN;
			if (
				Number.isFinite(lastMs) &&
				(acc.lastAt === null || lastMs > acc.lastAt)
			)
				acc.lastAt = lastMs;
		}
		return { store, ok: true, lanes: [...bySid.values()] };
	} catch (e) {
		return {
			store,
			ok: false,
			why: `store unreadable: ${e instanceof Error ? e.message : String(e)}`,
			lanes: [],
		};
	}
};

// ---- govdb surfaces (coord CLI only — no raw sqlite on governor.db) ----

export const coordBin = (): string =>
	`${process.env.HOME}/.claude/hooks/suspenders/bin/coord.ts`;

const shOut = (cmd: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

export const usageFactKey = (sid: string): string => `lane.${sid}.usage`;

/** compact JSON payload — facts are upserted whole, versions tick per flush */
export const usageFactPayload = (u: LaneUsage): string =>
	JSON.stringify({
		credits: Math.round(u.credits * 100) / 100,
		nano_aiu: Math.round(u.nanoAiu),
		in_tok: Math.round(u.inTok),
		out_tok: Math.round(u.outTok),
		cache_r: Math.round(u.cacheR),
		cache_w: Math.round(u.cacheW),
		sessions: u.sessions,
		models: [...u.models],
		updated_at: u.lastAt ?? null,
	});

/** Stamp `lane.<sid>.usage` facts via the coord CLI verb. Lanes with zero
 *  attributed spend are skipped (facts carry observations, not zeros).
 *  Returns the sids actually stamped. */
export const flushLaneUsageFacts = (
	report: MeterReport,
	opts: { bin?: string } = {},
): string[] => {
	if (!report.ok) return [];
	const bin = opts.bin ?? coordBin();
	const stamped: string[] = [];
	for (const lane of report.lanes) {
		if (lane.credits === 0 && lane.sessions === 0) continue;
		const r = shOut([
			process.execPath,
			bin,
			"fact",
			"set",
			usageFactKey(lane.sid),
			"--text",
			usageFactPayload(lane),
			"--source",
			"copilot-meter",
		]);
		if (r.code === 0) stamped.push(lane.sid);
	}
	return stamped;
};

/** Read one lane's stamped usage back (via `coord fact get`), parsed, or
 *  null when unset — the lane-status readers live here so every surface
 *  shares one parser. */
export const readLaneUsage = (
	sid: string,
	opts: { bin?: string } = {},
): LaneUsage | null => {
	const bin = opts.bin ?? coordBin();
	const r = shOut([process.execPath, bin, "fact", "get", usageFactKey(sid)]);
	if (r.code !== 0) return null;
	const first = r.out.split("\n")[0] ?? "";
	// fact get renders "<json> (vN)" or "(unset)"
	if (first === "(unset)") return null;
	const json = first.replace(/\s+\(v\d+\)$/, "");
	try {
		const p = JSON.parse(json) as Record<string, unknown>;
		return {
			sid,
			item: typeof p.item === "string" ? p.item : "",
			worktree: typeof p.worktree === "string" ? p.worktree : "",
			credits: num(p.credits),
			nanoAiu: num(p.nano_aiu),
			inTok: num(p.in_tok),
			outTok: num(p.out_tok),
			cacheR: num(p.cache_r),
			cacheW: num(p.cache_w),
			sessions: num(p.sessions),
			models: Array.isArray(p.models)
				? p.models.filter((m): m is string => typeof m === "string")
				: [],
			lastAt: typeof p.updated_at === "number" ? p.updated_at : null,
		};
	} catch {
		return null;
	}
};
