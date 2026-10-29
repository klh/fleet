// distill/status.ts — `knowledge-distill status`: coverage per job (% of
// eligible nodes visited within max_age_days), the stalest age, queue depth,
// the starvation (overdue) report, the day's token book, the lease holder
// and the last run row. One JSON contract; the text view renders from it.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { DistillConfig } from "./config.ts";
import { type DistillLease, observeLease } from "./lease.ts";
import { spentToday } from "./runner.ts";
import { ensureDistillSchema } from "./schema.ts";
import { JOBS, type JobCoverage, jobCoverage } from "./visits.ts";

export interface DistillStatus {
	enabled: boolean;
	issue: string | null;
	paused: boolean;
	lease: DistillLease | null;
	budget: { spent: number; limit: number };
	jobs: JobCoverage[];
	overdue: number;
	graph: { nodes: number; edges: number; candidates: number };
	lastRun: Record<string, unknown> | null;
}

export function distillStatus(
	db: Database,
	cfg: DistillConfig,
	opts: { issue: string | null; pausePath: string; decant: boolean },
	now: number = Date.now(),
): DistillStatus {
	ensureDistillSchema(db);
	const jobs = JOBS.filter((j) => j !== "decant" || opts.decant).map((j) =>
		jobCoverage(db, cfg, j, now),
	);
	const count = (sql: string): number =>
		(db.query(sql).get() as { n: number }).n;
	return {
		enabled: cfg.enabled && !opts.issue,
		issue: opts.issue,
		paused: existsSync(opts.pausePath),
		lease: observeLease(db),
		budget: { spent: spentToday(db, now), limit: cfg.token_budget_per_day },
		jobs,
		overdue: jobs.reduce((a, j) => a + j.overdue, 0),
		graph: {
			nodes: count("SELECT COUNT(*) AS n FROM kg_nodes"),
			edges: count("SELECT COUNT(*) AS n FROM kg_edges"),
			candidates: count(
				"SELECT COUNT(*) AS n FROM kg_edges WHERE state = 'candidate'",
			),
		},
		lastRun:
			(db
				.query("SELECT * FROM distill_runs ORDER BY id DESC LIMIT 1")
				.get() as Record<string, unknown> | null) ?? null,
	};
}

const age = (ms: number | null): string => {
	if (ms === null) return "—";
	const h = ms / 3_600_000;
	return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};

const pad = (s: string, n: number): string => s.padEnd(n);

export function renderStatus(st: DistillStatus): string {
	const lines = [
		`distill: ${st.enabled ? "enabled" : "disabled"}${st.paused ? " · PAUSED" : ""} · budget ${String(st.budget.spent)}/${String(st.budget.limit)} tokens today · lease ${st.lease ? `${st.lease.host}:${String(st.lease.pid)}` : "free"}`,
	];
	if (st.issue) lines.push(`config refused: ${st.issue}`);
	lines.push(
		`graph: ${String(st.graph.nodes)} nodes · ${String(st.graph.edges)} edges (${String(st.graph.candidates)} candidate)`,
		`${pad("JOB", 14)}${pad("ELIGIBLE", 10)}${pad("COVERAGE", 10)}${pad("OLDEST", 9)}${pad("NEVER", 7)}${pad("QUEUE", 7)}OVERDUE`,
	);
	for (const j of st.jobs)
		lines.push(
			`${pad(j.job, 14)}${pad(String(j.eligible), 10)}${pad(`${String(j.coverage)}%`, 10)}${pad(age(j.oldestMs), 9)}${pad(String(j.neverVisited), 7)}${pad(String(j.queue), 7)}${String(j.overdue)}`,
		);
	if (st.overdue > 0)
		lines.push(
			`OVERDUE: ${String(st.overdue)} node-visits past max_age — the walker is starving; widen the window or raise batch`,
		);
	const r = st.lastRun;
	lines.push(
		r
			? `last run #${String(r.id)}: ${String(r.outcome)} · items ${String(r.items)} · tokens ${String(r.tokens)} · ${String(r.ms)}ms${r.preempted ? ` · preempted at ${String(r.stopped_job)}#${String(r.stopped_entry)}` : ""}${r.detail ? ` · ${String(r.detail)}` : ""}`
			: "last run: none",
	);
	return lines.join("\n");
}
