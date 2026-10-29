// distill/runner.ts — one distiller run. Order of gates: kill switch →
// enabled → hub lease → idle verdict → index (knowledge rows + decant
// sessions → nodes) → jobs, stalest-first per job. Between EVERY unit the
// idle verdict is re-read (preempt), the job wall budget is checked, and
// LLM units check the per-day token book. A visit is stamped only after its
// unit committed. An upstream "not now" (408/429/503/504) stops the job for
// this run — the distiller never retries into a busy provider. Every run
// leaves one run row, one NDJSON line and one `knowledge.distilled` event.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DistillClients } from "./clients.ts";
import { UpstreamBusy } from "./clients.ts";
import type { DistillConfig } from "./config.ts";
import {
	BudgetExhausted,
	type JobContext,
	type Prepare,
	type Unit,
} from "./context.ts";
import { decantUnit, indexDecantSessions } from "./decant.ts";
import { type IdleSignals, idleVerdict } from "./idle.ts";
import {
	crosslinkPrepare,
	crosslinkUnit,
	dedupeUnit,
	extractUnit,
	stalenessUnit,
} from "./jobs-local.ts";
import { contradictionUnit, distillUnit } from "./jobs-llm.ts";
import { acquireLease, releaseLease } from "./lease.ts";
import { ensureDistillSchema } from "./schema.ts";
import { type DistillSink, syncEntries } from "./sink.ts";
import { VectorIndex } from "./vectors.ts";
import { type Job, JOBS, pickBatch, stampVisit } from "./visits.ts";

const UNITS: Record<Job, { unit: Unit; prepare?: Prepare; llm: boolean }> = {
	extract: { unit: extractUnit, llm: false },
	decant: { unit: decantUnit, llm: false },
	staleness: { unit: stalenessUnit, llm: false },
	crosslink: { unit: crosslinkUnit, prepare: crosslinkPrepare, llm: false },
	dedupe: { unit: dedupeUnit, llm: false },
	contradiction: { unit: contradictionUnit, llm: true },
	distill: { unit: distillUnit, llm: true },
};

export interface DistillDeps {
	db: Database;
	cfg: DistillConfig;
	clients: DistillClients;
	sink: DistillSink;
	decant: Database | null;
	signals: () => Promise<IdleSignals>;
	emit: (kind: string, payload: Record<string, unknown>) => void;
	logPath: string;
	pausePath: string;
	nonce: string;
	now?: () => number;
	/** lease liveness inspector (test seam; production = process birth) */
	inspect?: Parameters<typeof acquireLease>[2];
}

export interface RunSummary {
	runId: number | null;
	outcome: string;
	items: number;
	tokens: number;
	ms: number;
	preempted: boolean;
	stoppedJob: Job | null;
	stoppedEntry: number | null;
	perJob: Record<string, number>;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function spentToday(db: Database, now: number): number {
	return (
		(
			db
				.query("SELECT tokens FROM distill_budget WHERE day = ?")
				.get(dayOf(now)) as {
				tokens: number;
			} | null
		)?.tokens ?? 0
	);
}

function writeRun(
	deps: DistillDeps,
	s: RunSummary,
	started: number,
	detail: string,
): number {
	const now = (deps.now ?? Date.now)();
	const id = Number(
		deps.db
			.query(
				"INSERT INTO distill_runs (started_at, ended_at, outcome, stopped_job, stopped_entry, items, tokens, ms, preempted, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				started,
				now,
				s.outcome,
				s.stoppedJob,
				s.stoppedEntry,
				s.items,
				s.tokens,
				s.ms,
				s.preempted ? 1 : 0,
				detail.slice(0, 1000),
			).lastInsertRowid,
	);
	try {
		mkdirSync(dirname(deps.logPath), { recursive: true });
		appendFileSync(
			deps.logPath,
			`${JSON.stringify({ ts: new Date(now).toISOString(), run: id, job: s.stoppedJob ?? "all", outcome: s.outcome, items: s.items, tokens: s.tokens, ms: s.ms, preempted: s.preempted, per_job: s.perJob })}\n`,
		);
	} catch {} // the run row is the durable record; the log is a feed
	try {
		deps.emit("knowledge.distilled", { run: id, ...s, runId: undefined });
	} catch {}
	return id;
}

/** One run. `force` skips ONLY the enabled + idle gates (operator --force);
 *  the kill switch and the lease always apply. */
export async function runOnce(
	deps: DistillDeps,
	opts: { force?: boolean; jobs?: Job[] } = {},
): Promise<RunSummary> {
	const now = deps.now ?? Date.now;
	const started = now();
	const s: RunSummary = {
		runId: null,
		outcome: "ok",
		items: 0,
		tokens: 0,
		ms: 0,
		preempted: false,
		stoppedJob: null,
		stoppedEntry: null,
		perJob: {},
	};
	ensureDistillSchema(deps.db);
	const finish = (outcome: string, detail = ""): RunSummary => {
		s.outcome = outcome;
		s.ms = now() - started;
		s.runId = writeRun(deps, s, started, detail);
		return s;
	};
	if (existsSync(deps.pausePath)) return finish("paused");
	if (!deps.cfg.enabled && !opts.force) return finish("disabled");
	if (!acquireLease(deps.db, deps.nonce, deps.inspect, started))
		return finish("standby");
	try {
		if (!opts.force) {
			const v = idleVerdict(await deps.signals(), deps.cfg);
			if (!v.idle) return finish("skipped", v.reason);
		}
		syncEntries(deps.db, now());
		if (deps.decant) indexDecantSessions(deps.db, deps.decant, now());
		return await runJobs(deps, s, opts, finish);
	} finally {
		releaseLease(deps.db, deps.nonce);
	}
}

async function runJobs(
	deps: DistillDeps,
	s: RunSummary,
	opts: { force?: boolean; jobs?: Job[] },
	finish: (outcome: string, detail?: string) => RunSummary,
): Promise<RunSummary> {
	const now = deps.now ?? Date.now;
	const cfg = deps.cfg;
	const ctx: JobContext = {
		db: deps.db,
		cfg,
		clients: deps.clients,
		sink: deps.sink,
		decant: deps.decant,
		vectors: new VectorIndex(deps.db),
		now,
		spend: {
			check: () => {
				if (spentToday(deps.db, now()) >= cfg.token_budget_per_day)
					throw new BudgetExhausted("daily token budget spent");
			},
			add: (tokens) => {
				deps.db
					.query(
						"INSERT INTO distill_budget (day, tokens) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
					)
					.run(dayOf(now()), tokens);
			},
		},
	};
	const jobs = (opts.jobs ?? [...JOBS]).filter(
		(j) => j !== "decant" || deps.decant,
	);
	const notes: string[] = [];
	for (const job of jobs) {
		const spec = UNITS[job];
		const deadline = now() + cfg.max_job_ms;
		const batch = pickBatch(deps.db, cfg, job, cfg.batch, now());
		if (!batch.length) continue;
		if (spec.prepare)
			try {
				await spec.prepare(ctx, batch);
			} catch (e) {
				notes.push(`${job}: prepare ${String(e)}`.slice(0, 200));
				continue;
			}
		for (const node of batch) {
			if (!opts.force) {
				const v = idleVerdict(await deps.signals(), cfg);
				if (!v.idle) {
					s.preempted = true;
					s.stoppedJob = job;
					s.stoppedEntry = node.id;
					return finish("preempted", v.reason);
				}
			}
			if (now() > deadline) {
				notes.push(`${job}: wall budget`);
				break;
			}
			try {
				const r = await spec.unit(ctx, node);
				s.tokens += r.tokens ?? 0;
				stampVisit(
					deps.db,
					node.id,
					job,
					{ hash: node.hash, usage: node.usage },
					r.outcome,
					now(),
				);
				s.items++;
				s.perJob[job] = (s.perJob[job] ?? 0) + 1;
			} catch (e) {
				if (e instanceof BudgetExhausted) {
					s.stoppedJob = job;
					s.stoppedEntry = node.id;
					return finish("budget", e.message);
				}
				if (e instanceof UpstreamBusy) {
					notes.push(`${job}: upstream busy`);
					break;
				}
				// a deterministic failure is recorded on the visit so the entry
				// does not wedge the head of the queue
				stampVisit(
					deps.db,
					node.id,
					job,
					{ hash: node.hash, usage: node.usage },
					`error: ${String(e)}`,
					now(),
				);
				notes.push(`${job}#${String(node.id)}: ${String(e)}`.slice(0, 200));
			}
		}
	}
	return finish(notes.length ? "ok:notes" : "ok", notes.join(" | "));
}
