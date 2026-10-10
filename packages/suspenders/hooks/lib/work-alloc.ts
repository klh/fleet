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
import { unmergedDeps, type DepRow } from "./dep-merge-gate.ts";
import { laneAlive, transcriptPath, type LaneRef } from "./lane-liveness.ts";
import type { GovernorStore } from "./govdb.ts";

// the verified oh-my-codex weights (W515 brief description)
export const ROLE_BONUS = 18; // +18 role-grouping
export const AFFINITY_WEIGHT = 4; // ×4 path/domain-hint affinity
export const LOAD_PENALTY = 4; // −4 per held item

export type AllocLane = {
	sid: string;
	live: boolean;
	caps: string[];
	hints: string[]; // path/domain tokens (worktree segments)
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

// path/domain-hint tokens: scope segments + slash-paths from title/description
const PATH_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;
export function hintTokens(
	scope: string | null,
	title: string,
	description?: string | null,
): string[] {
	const tokens = new Set<string>();
	for (const seg of String(scope ?? "")
		.split(/[^A-Za-z0-9_.-]/)
		.filter(Boolean))
		tokens.add(seg.toLowerCase());
	for (const raw of [title, description]) {
		if (!raw) continue;
		for (const m of String(raw).matchAll(PATH_RE))
			for (const seg of m[0].toLowerCase().split("/")) tokens.add(seg);
	}
	return [...tokens];
}

// the greedy scorer: one (item, lane) pair → score + reason parts.
// Ineligible (requires ⊄ caps) is the planner's job — this scores pairs.
export function scoreLane(
	item: { requires: string[]; hints: string[] },
	lane: AllocLane,
	load: number,
): { score: number; parts: string[] } {
	let score = 0;
	const parts: string[] = [];
	if (
		item.requires.length &&
		item.requires.every((r) => lane.caps.includes(r))
	) {
		score += ROLE_BONUS;
		parts.push("role +18");
	}
	const hits = item.hints.filter((h) => lane.hints.includes(h));
	if (item.hints.length && hits.length) {
		const pts =
			Math.round(((AFFINITY_WEIGHT * hits.length) / item.hints.length) * 10) /
			10;
		score += pts;
		parts.push(`affinity +${pts}`);
	}
	if (load > 0) {
		score -= LOAD_PENALTY * load;
		parts.push(`load -${LOAD_PENALTY * load}`);
	}
	return { score, parts };
}

// candidate lanes from the .fleet/lanes.json registry: liveness via laneAlive
// (process identity / transcript lease), capabilities from the sessions
// table, path hints from each lane's worktree.
export function candidateLanes(
	store: GovernorStore,
	entries: LaneRef[],
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
	return entries.map((e) => ({
		sid: e.sid,
		live: laneAlive(e),
		caps: capsBySid.get(e.sid) ?? [],
		hints: String(e.worktree ?? "")
			.split(/[^A-Za-z0-9_.-]/)
			.filter(Boolean),
	}));
}

export type PlanOpts = { capacity?: number; items?: string[] };

// deterministic ranking: higher score wins; on a tie the LIVE lane wins (an
// assign beats a recommend at equal score); then the lexicographically
// smaller sid — same items, same lanes, same plan every time
export function beats(
	x: { lane: AllocLane; score: number },
	y: { lane: AllocLane; score: number },
): boolean {
	if (x.score !== y.score) return x.score > y.score;
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
		const itemHints = hintTokens(it.scope, it.title, it.description);
		let best: {
			lane: AllocLane;
			score: number;
			parts: string[];
		} | null = null;
		for (const lane of lanes) {
			if (stuck.has(lane.sid)) continue; // blocked → lighter lanes
			if (requires.length && !requires.every((r) => lane.caps.includes(r)))
				continue;
			const cur = load.get(lane.sid) ?? 0;
			const { score, parts } = scoreLane(
				{ requires, hints: itemHints },
				lane,
				cur,
			);
			if (!best || beats({ lane, score }, best)) best = { lane, score, parts };
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

export type AssignOutcome = { ok: boolean; why?: string };

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
		return { ok: true };
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
