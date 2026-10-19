// work-alloc.ts — W515: allocation scorer + decision-object rebalance for the
// work graph, ported from the verified oh-my-codex mechanism
// (src/team/allocation-policy.ts + rebalance-policy.ts): a greedy scorer
// (+18 role-grouping = item.requires ⊆ lane capabilities, ×4 path/domain-hint
// affinity, −4 load, stuck lanes skipped so work flows to lighter lanes,
// deterministic sid tiebreak), items ordered reclaimed-first FIFO (stranded
// work allocates first), PURE by default: decisions {assign|recommend}, and
// every assignment (manual takes included) gets an alloc_reason on the row +
// work.claimed payload for auditability. assignTask() is the SOLE assignment
// gateway: CAS claim + claim coupling + post-lock readiness recheck (deps all
// DONE and verified merged) in one transaction.
// W646: scope-hint overlap lifted from OMX — hintTokens splits into
// HintSet{paths,words} (path tokens weigh ×3 inside the ×4 affinity), the
// scorer matches item hints against worktree hints ∪ recent-claim history
// (candidateLanes reads the lane's last items), a lane owning scope with zero
// overlap takes SCOPE_MISS_PENALTY, ties break score > overlap > load >
// live > sid, and the reason string carries the matched tokens as evidence.
import { unmergedDeps, type DepRow } from "./dep-merge-gate.ts";
import { laneAlive, transcriptPath, type LaneRef } from "./lane-liveness.ts";
import type { GovernorStore } from "./govdb.ts";
import { clearReclaimMarker } from "./reclaim-sticky.ts";
import { claimTokenHash, claimTokenMint } from "./work-fence.ts";

// the verified oh-my-codex weights (W515 brief description)
export const ROLE_BONUS = 18; // +18 role-grouping
export const AFFINITY_WEIGHT = 4; // ×4 path/domain-hint affinity
export const LOAD_PENALTY = 4; // −4 per held item
export const SCOPE_MISS_PENALTY = 3; // −3 owns-scope-but-zero-overlap (OMX)
export const PATH_HINT_WEIGHT = 3; // path hints weigh ×3 inside affinity

export type AllocLane = {
	sid: string;
	live: boolean;
	caps: string[];
	hints: string[]; // path/domain tokens (worktree segments)
	history?: string[]; // W646: hint tokens from the lane's recent claims
};

export type AllocDecision = {
	kind: "assign" | "recommend";
	item: string;
	sid: string;
	score: number;
	reason: string; // the allocation_reason stamped on the item + event
	live: boolean; // target lane liveness at plan time
};

type ReadyRow = {
	id: string;
	title: string;
	requires: string | null;
	scope: string | null;
	description: string | null;
	updated_at: number;
};

// path/domain-hint extraction: slash-paths in title/description → paths
// (weighted ×3 in affinity); scope segments → domain words (weight 1). W646:
// the split lets the scorer weight file-path evidence above loose domain words.
const PATH_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;
export type HintSet = { paths: string[]; words: string[] };
export function hintSet(
	scope: string | null,
	title: string,
	description?: string | null,
): HintSet {
	const paths = new Set<string>();
	const words = new Set<string>();
	for (const seg of String(scope ?? "")
		.split(/[^A-Za-z0-9_.-]/)
		.filter(Boolean))
		words.add(seg.toLowerCase());
	for (const raw of [title, description]) {
		if (!raw) continue;
		for (const m of String(raw).matchAll(PATH_RE))
			for (const seg of m[0].toLowerCase().split("/")) paths.add(seg);
	}
	// a token known both ways counts once, as a path (the stronger evidence)
	return {
		paths: [...paths].filter((p) => !words.has(p)),
		words: [...words],
	};
}

// flat union, paths last (dedupe across sources) — plain token list for
// callers/tests that don't care about the path/word split
export function hintTokens(
	scope: string | null,
	title: string,
	description?: string | null,
): string[] {
	const { paths, words } = hintSet(scope, title, description);
	return [...words, ...paths];
}

// the greedy scorer: one (item, lane) pair → score + reason parts + overlap
// count (the tiebreak evidence). W646: lane knowledge = worktree hints ∪
// recent-claim history; path hits weigh ×3 inside the ×4 affinity; a lane
// with scope knowledge but zero overlap takes the fresh-lane penalty.
// Ineligible (requires ⊄ caps) is the planner's job — this scores pairs.
export function scoreLane(
	item: { requires: string[]; hints: HintSet },
	lane: AllocLane,
	load: number,
): { score: number; parts: string[]; overlap: number } {
	let score = 0;
	const parts: string[] = [];
	if (
		item.requires.length &&
		item.requires.every((r) => lane.caps.includes(r))
	) {
		score += ROLE_BONUS;
		parts.push("role +18");
	}
	const known = new Set([...lane.hints, ...(lane.history ?? [])]);
	const pathHits = item.hints.paths.filter((p) => known.has(p));
	const wordHits = item.hints.words.filter((w) => known.has(w));
	const overlap = pathHits.length + wordHits.length;
	const total =
		PATH_HINT_WEIGHT * item.hints.paths.length + item.hints.words.length;
	if (total > 0) {
		if (overlap > 0) {
			const weighted = PATH_HINT_WEIGHT * pathHits.length + wordHits.length;
			const pts = Math.round(((AFFINITY_WEIGHT * weighted) / total) * 10) / 10;
			score += pts;
			const ev = [...pathHits, ...wordHits].slice(0, 5).join(",");
			parts.push(`affinity +${pts} [${ev}]`);
		} else if (lane.hints.length || lane.history?.length) {
			score -= SCOPE_MISS_PENALTY;
			parts.push(`scope-penalty -${SCOPE_MISS_PENALTY}`);
		}
	}
	if (load > 0) {
		score -= LOAD_PENALTY * load;
		parts.push(`load -${LOAD_PENALTY * load}`);
	}
	return { score, parts, overlap };
}

// candidate lanes from the .fleet/lanes.json registry: liveness via laneAlive
// (process identity / transcript lease), capabilities from the sessions
// table, path hints from each lane's worktree, and (W646) hint tokens from
// the lane's recent claims — files/paths named in its last owned items.
export function candidateLanes(
	store: GovernorStore,
	entries: LaneRef[],
	project?: string,
): AllocLane[] {
	const capsBySid = new Map<string, string[]>();
	if (entries.length) {
		const marks = entries.map(() => "?").join(",");
		for (const r of store
			.query(`SELECT sid, capabilities FROM sessions WHERE sid IN (${marks})`)
			.all(...entries.map((e) => e.sid)) as {
			sid: string;
			capabilities: string | null;
		}[])
			capsBySid.set(
				r.sid,
				String(r.capabilities ?? "")
					.split(",")
					.filter(Boolean),
			);
	}
	// W646 lane history: hint tokens from the lane's recent claims — files and
	// paths named in its last ≤8 owned items, newest first. Skipped without a
	// project (advice call sites may omit it).
	const historyBySid = new Map<string, Set<string>>();
	const seen = new Map<string, number>();
	if (project && entries.length) {
		const marks = entries.map(() => "?").join(",");
		const rows = store
			.query(
				`SELECT owner_sid, title, description, scope FROM work_items WHERE project = ? AND owner_sid IN (${marks}) AND state IN ('CLAIMED','RUNNING','ORPHANED','DONE') ORDER BY updated_at DESC`,
			)
			.all(project, ...entries.map((e) => e.sid)) as {
			owner_sid: string;
			title: string;
			description: string | null;
			scope: string | null;
		}[];
		for (const r of rows) {
			if ((seen.get(r.owner_sid) ?? 0) >= 8) continue;
			seen.set(r.owner_sid, (seen.get(r.owner_sid) ?? 0) + 1);
			const set = historyBySid.get(r.owner_sid) ?? new Set<string>();
			for (const t of hintTokens(r.scope, String(r.title), r.description))
				set.add(t);
			historyBySid.set(r.owner_sid, set);
		}
	}
	return entries.map((e) => ({
		sid: e.sid,
		live: laneAlive(e),
		caps: capsBySid.get(e.sid) ?? [],
		hints: String(e.worktree ?? "")
			.split(/[^A-Za-z0-9_.-]/)
			.filter(Boolean),
		history: [...(historyBySid.get(e.sid) ?? [])],
	}));
}

export type PlanOpts = { capacity?: number; items?: string[] };

// deterministic ranking (W646): higher score wins; ties break by more overlap
// evidence, then lower load, then the live lane (assign beats recommend at
// equal score), then the lexicographically smaller sid — same items, same
// lanes, same plan every time. Chain: score > overlap > load > live > sid.
export function beats(
	x: {
		lane: AllocLane;
		score: number;
		overlap: number;
		load: number;
	},
	y: { lane: AllocLane; score: number; overlap: number; load: number },
): boolean {
	if (x.score !== y.score) return x.score > y.score;
	if (x.overlap !== y.overlap) return x.overlap > y.overlap;
	if (x.load !== y.load) return x.load < y.load;
	if (x.lane.live !== y.lane.live) return x.lane.live;
	return x.lane.sid < y.lane.sid;
}

// the planner: PURE — reads state, emits decision objects, mutates nothing.
// READY items ordered reclaimed-first FIFO (operator-reclaimed items first,
// oldest first), each takes its best eligible lane by score with a
// deterministic sid tiebreak; in-plan assignments raise the lane's load so
// the next item sees the true greedy picture.
export function planAllocation(
	store: GovernorStore,
	project: string,
	lanes: AllocLane[],
	opts: PlanOpts = {},
): AllocDecision[] {
	const capacity = Math.max(1, opts.capacity ?? 1);
	const ready = store
		.query(
			"SELECT id, title, requires, scope, description, updated_at FROM work_items WHERE project = ? AND state = 'READY'",
		)
		.all(project) as ReadyRow[];
	const items = opts.items
		? ready.filter((r) => opts.items?.includes(String(r.id)))
		: ready;
	const load = new Map<string, number>();
	const stuck = new Set<string>();
	for (const r of store
		.query(
			"SELECT owner_sid, COUNT(*) AS n, SUM(CASE WHEN state = 'ORPHANED' THEN 1 ELSE 0 END) AS stuck FROM work_items WHERE project = ? AND owner_sid IS NOT NULL AND state IN ('CLAIMED','RUNNING','ORPHANED') GROUP BY owner_sid",
		)
		.all(project) as { owner_sid: string; n: number; stuck: number }[]) {
		load.set(String(r.owner_sid), Number(r.n));
		if (Number(r.stuck) > 0) stuck.add(String(r.owner_sid));
	}
	// reclaimed-first: the ts of the item's latest operator reclaim, if any
	const reclaimed = new Map<string, number>();
	for (const r of items) {
		const ev = store
			.query(
				"SELECT ts, payload FROM events WHERE kind = 'work.released' AND payload LIKE ? ORDER BY ts DESC LIMIT 1",
			)
			.get(`%"work":"${String(r.id)}"%`) as {
			ts: number;
			payload: string;
		} | null;
		if (!ev) continue;
		const reason = (JSON.parse(ev.payload) as { reason?: string }).reason;
		if (["operator-reclaim", "reclaim-all"].includes(String(reason)))
			reclaimed.set(String(r.id), Number(ev.ts));
	}
	const order = [...items].sort(
		(a, b) =>
			(reclaimed.has(String(a.id)) ? 0 : 1) -
				(reclaimed.has(String(b.id)) ? 0 : 1) ||
			Number(a.updated_at) - Number(b.updated_at) ||
			String(a.id).localeCompare(String(b.id)),
	);
	const decisions: AllocDecision[] = [];
	for (const it of order) {
		const requires = String(it.requires ?? "")
			.split(",")
			.filter(Boolean);
		const itemHints = hintSet(it.scope, it.title, it.description);
		let best: {
			lane: AllocLane;
			score: number;
			parts: string[];
			overlap: number;
			load: number;
		} | null = null;
		for (const lane of lanes) {
			if (stuck.has(lane.sid)) continue; // blocked → lighter lanes
			if (requires.length && !requires.every((r) => lane.caps.includes(r)))
				continue;
			const cur = load.get(lane.sid) ?? 0;
			const { score, parts, overlap } = scoreLane(
				{ requires, hints: itemHints },
				lane,
				cur,
			);
			const cand = { lane, score, parts, overlap, load: cur };
			if (!best || beats(cand, best)) best = cand;
		}
		if (!best) continue; // no eligible lane at all — nothing to suggest
		const free = best.lane.live && (load.get(best.lane.sid) ?? 0) < capacity;
		const suffix = free
			? ""
			: ` — ${best.lane.live ? "at capacity" : "target not live"}`;
		const parts = best.parts.length ? ` (${best.parts.join(", ")})` : "";
		decisions.push({
			kind: free ? "assign" : "recommend",
			item: String(it.id),
			sid: best.lane.sid,
			score: best.score,
			reason: `score=${best.score}${parts}${suffix}`,
			live: best.lane.live,
		});
		if (free) load.set(best.lane.sid, (load.get(best.lane.sid) ?? 0) + 1);
	}
	return decisions;
}

export type AssignOutcome = {
	ok: boolean;
	why?: string;
	/** W643: the raw claim token, minted fresh at every successful take —
	 *  printed once by work take; only its sha256 rides the item row. */
	token?: string;
};

// assignTask — the SOLE assignment gateway (oh-my-codex lift): CAS
// READY→CLAIMED + claim coupling + post-lock readiness recheck (deps all DONE
// and verified merged — done ≠ merged, W60) in ONE transaction, stamping the
// allocation_reason on the row and the work.claimed event. Returns
// {ok:false} instead of dying — the caller owns its failure surface.
export function assignTask(
	store: GovernorStore,
	project: string,
	args: { id: string; sid: string; reason: string; origin?: string | null },
): AssignOutcome {
	const claim = store.transaction((): AssignOutcome => {
		const it = store
			.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
			.get(project, args.id) as
			| (ReadyRow & {
					state: string;
					owner_sid: string | null;
					scope: string | null;
			  })
			| undefined;
		if (!it) return { ok: false, why: "no such work item" };
		if (it.state !== "READY")
			return { ok: false, why: `not READY (${it.state})` };
		const depRows = store
			.query(
				"SELECT d.depends_on, w.state, w.result_sha FROM work_deps d LEFT JOIN work_items w ON w.id = d.depends_on AND w.project = d.project WHERE d.project = ? AND d.work_id = ?",
			)
			.all(project, args.id) as DepRow[];
		if (depRows.some((d) => d.state !== "DONE"))
			return { ok: false, why: "unmet dependencies" };
		if (unmergedDeps(depRows, project).length)
			return { ok: false, why: "dep done but sha not merged to main" };
		const r = store
			.query(
				"UPDATE work_items SET state = 'CLAIMED', owner_sid = ?, alloc_reason = ?, origin = COALESCE(?, origin), updated_at = ? WHERE project = ? AND id = ? AND state = 'READY'",
			)
			.run(
				args.sid,
				args.reason,
				args.origin ?? null,
				Date.now(),
				project,
				args.id,
			);
		if (r.changes === 0) return { ok: false, why: "race lost" };
		// W643 claim-token fence: every successful take mints a fresh token —
		// a re-take after reclaim invalidates the previous claimant's token, so
		// a stale writer mismatches at done instead of clobbering the row.
		const token = claimTokenMint();
		store
			.query(
				"UPDATE work_items SET claim_token_hash = ? WHERE project = ? AND id = ?",
			)
			.run(claimTokenHash(token), project, args.id);
		// W831 sticky-until-resume: a successful claim IS the resume — the
		// reclaim marker (reclaim.reason.<project>.<id>) converges here.
		clearReclaimMarker(store, project, args.id);
		if (it.scope)
			store
				.query(
					"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts, tp) VALUES (?, ?, 'work-graph', 0, ?, ?)",
				)
				.run(args.sid, it.scope, Date.now(), transcriptPath(args.sid) ?? "");
		store
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, 'work', 'work.claimed', scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
			)
			.run(
				Date.now(),
				JSON.stringify({
					work: args.id,
					project,
					by: args.sid,
					alloc_reason: args.reason,
				}),
				project,
				args.id,
			);
		return { ok: true, token };
	})();
	return claim;
}

// human-readable plan: one line per decision, ready order preserved
export function renderAllocPlan(decisions: AllocDecision[]): string {
	return decisions
		.map((d) => {
			const lane = `${d.sid.slice(0, 8)}${d.live ? "" : " (dead)"}`;
			return `${d.item} → ${lane}  ${d.kind}  ${d.reason}`;
		})
		.join("\n");
}

// --apply: claim ONLY the assign decisions, through the sole gateway. Pure
// result — the caller owns the printing. Racing claims show up as skips.
export function applyAllocations(
	store: GovernorStore,
	project: string,
	decisions: AllocDecision[],
): { applied: string[]; skipped: { item: string; why: string }[] } {
	const applied: string[] = [];
	const skipped: { item: string; why: string }[] = [];
	for (const d of decisions) {
		if (d.kind !== "assign") continue;
		const r = assignTask(store, project, {
			id: d.item,
			sid: d.sid,
			reason: `allocate: ${d.reason}`,
		});
		if (r.ok) applied.push(d.item);
		else skipped.push({ item: d.item, why: String(r.why) });
	}
	return { applied, skipped };
}
