// distill/visits.ts — the per-entry visit ledger and stalest-first picker.
// Each job tracks its own visits per node: (entry_id, job) → when, the hash
// and usage seen, the outcome. The next batch is the highest score:
//   age since last visit (never visited = oldest of all)
//   + hash-changed boost + usage-rose boost + neighbours-changed boost
// (config weights). A visit is stamped only AFTER its unit commits, so a
// preempted run leaves its unfinished entries the oldest — the next quiet
// window resumes exactly there; no separate cursor exists. An unchanged
// entry is not revisited before min_revisit_h (the score floor).
import type { Database } from "bun:sqlite";
import { type DistillConfig, weightsMs } from "./config.ts";
import type { NodeKind, NodeRow } from "./graph.ts";

export const JOBS = [
	"extract",
	"decant",
	"staleness",
	"crosslink",
	"dedupe",
	"contradiction",
	"distill",
] as const;
export type Job = (typeof JOBS)[number];

/** Which node kinds each job walks. */
export const JOB_KINDS: Record<Job, NodeKind[]> = {
	extract: ["entry"],
	decant: ["session"],
	staleness: ["entry", "code"],
	crosslink: ["entry"],
	dedupe: ["entry"],
	contradiction: ["entry"],
	distill: ["entry"],
};

export type Picked = NodeRow & { score: number; visited_at: number | null };

/** Score SQL shared by the picker and the queue-depth count. */
const scored = (kinds: NodeKind[]): string => `
	SELECT n.*, v.last_visited_at AS visited_at,
		(?1 - COALESCE(v.last_visited_at, 0))
		+ CASE WHEN v.entry_id IS NOT NULL AND COALESCE(n.hash, '') != COALESCE(v.last_hash, '') THEN ?2 ELSE 0 END
		+ CASE WHEN v.entry_id IS NOT NULL AND n.usage > v.last_usage THEN ?3 ELSE 0 END
		+ CASE WHEN v.entry_id IS NOT NULL AND n.edge_at > v.last_visited_at THEN ?4 ELSE 0 END
		AS score
	FROM kg_nodes n LEFT JOIN distill_visits v ON v.entry_id = n.id AND v.job = ?5
	WHERE n.kind IN (${kinds.map((k) => `'${k}'`).join(",")}) AND n.state = 'active'`;

const params = (
	c: DistillConfig,
	job: Job,
	now: number,
): (number | string)[] => {
	const w = weightsMs(c);
	return [now, w.hash, w.usage, w.neighbours, job];
};

/** The next `n` nodes for `job`, stalest-first, above the revisit floor. */
export function pickBatch(
	db: Database,
	c: DistillConfig,
	job: Job,
	n: number,
	now: number = Date.now(),
): Picked[] {
	return db
		.query(
			`SELECT * FROM (${scored(JOB_KINDS[job])}) WHERE score >= ?6 ORDER BY score DESC, id LIMIT ?7`,
		)
		.all(...params(c, job, now), weightsMs(c).minRevisit, n) as Picked[];
}

/** Stamp one visit — call only after the unit's writes committed. */
export function stampVisit(
	db: Database,
	nodeId: number,
	job: Job,
	seen: { hash: string | null; usage: number },
	outcome: string,
	now: number = Date.now(),
): void {
	db.query(
		"INSERT INTO distill_visits (entry_id, job, last_visited_at, last_hash, last_usage, last_outcome, visits) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (entry_id, job) DO UPDATE SET last_visited_at = excluded.last_visited_at, last_hash = excluded.last_hash, last_usage = excluded.last_usage, last_outcome = excluded.last_outcome, visits = distill_visits.visits + 1",
	).run(nodeId, job, now, seen.hash, seen.usage, outcome.slice(0, 200));
}

export interface JobCoverage {
	job: Job;
	eligible: number;
	/** % of eligible nodes visited within max_age_days */
	coverage: number;
	/** age (ms) of the stalest node; never-visited counts from first_seen */
	oldestMs: number | null;
	neverVisited: number;
	/** nodes the picker would take now (above the revisit floor) */
	queue: number;
	/** nodes not visited within max_age_days — the starvation report */
	overdue: number;
}

export function jobCoverage(
	db: Database,
	c: DistillConfig,
	job: Job,
	now: number = Date.now(),
): JobCoverage {
	const maxAge = c.max_age_days * 86_400_000;
	const row = db
		.query(
			`SELECT COUNT(*) AS eligible,
				SUM(CASE WHEN visited_at IS NOT NULL AND ?1 - visited_at <= ?6 THEN 1 ELSE 0 END) AS fresh,
				SUM(CASE WHEN visited_at IS NULL THEN 1 ELSE 0 END) AS never,
				SUM(CASE WHEN score >= ?7 THEN 1 ELSE 0 END) AS queue,
				SUM(CASE WHEN ?1 - COALESCE(visited_at, first_seen) > ?6 THEN 1 ELSE 0 END) AS overdue,
				MAX(?1 - COALESCE(visited_at, first_seen)) AS oldest
			FROM (${scored(JOB_KINDS[job])})`,
		)
		.get(...params(c, job, now), maxAge, weightsMs(c).minRevisit) as {
		eligible: number;
		fresh: number | null;
		never: number | null;
		queue: number | null;
		overdue: number | null;
		oldest: number | null;
	};
	return {
		job,
		eligible: row.eligible,
		coverage: row.eligible
			? Math.round(((row.fresh ?? 0) / row.eligible) * 1000) / 10
			: 100,
		oldestMs: row.oldest,
		neverVisited: row.never ?? 0,
		queue: row.queue ?? 0,
		overdue: row.overdue ?? 0,
	};
}
