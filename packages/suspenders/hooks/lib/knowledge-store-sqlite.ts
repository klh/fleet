// knowledge-store-sqlite.ts — the local knowledge adapter, extracted from
// knowledge-ports.ts (W1238.6.6 decompose): the ONLY place in the knowledge
// layer allowed to open governor.db (#9b). The port interfaces stay in
// knowledge-ports.ts; this module implements KnowledgeStore against
// knowledge.db (SQLite/WAL) + FTS5 + knowledge_queue. knowledge-ports
// re-exports the class so import sites stay byte-stable.
import type { Database } from "bun:sqlite";
import { CONFIDENCE_MIN, makeStamp } from "./confidence.ts";
import { openGovernorDb } from "./govdb.ts";
import {
	docForRef,
	findNearDuplicate,
	knowledgeSearch,
	type KnowledgeHit,
	loadDocs,
	loadRootDocs,
	substitutionCheck,
} from "./knowledge.ts";
import {
	type CurateRow,
	type DecayPlan,
	type DecayOpts,
	type Dismissal,
	type OpenProposal,
	planDecayProposals,
} from "./knowledge-curate.ts";
import type {
	DecaySweep,
	KnowledgeJob,
	KnowledgeProposalView,
	KnowledgeSearchFilters,
	KnowledgeStore,
	KnowledgeUpsert,
	NearDupProposal,
	ReprocessReport,
} from "./knowledge-ports.ts";
// W244 checkpoint rows: the prompt-hash helper stayed with the distill layer
// in knowledge-ports.ts — call-time use, so the module cycle is benign.
import { currentPromptHash } from "./knowledge-ports.ts";

// ─── local adapter: knowledge.db (SQLite/WAL) + FTS5 + knowledge_queue ───
// the ONLY place in the knowledge layer allowed to open governor.db (#9b)
export class SqliteKnowledgeStore implements KnowledgeStore {
	// governor handle for the control-plane bus INSERTs only (emitLanded,
	// curateRecord) — knowledge rows and the queue ride `db` (knowledge.db).
	private gov: Database | null;

	constructor(
		private db: Database,
		governor?: Database | null,
	) {
		this.gov = governor ?? null;
	}

	// lazy, cached: the events bus lives in governor.db, opened on first use
	// so tests can inject both handles (or none, defaulting to the files).
	private bus(): Database {
		if (!this.gov) this.gov = openGovernorDb();
		return this.gov;
	}

	async peekNext(): Promise<{ id: number } | null> {
		return (
			(this.db
				.query(
					"SELECT id FROM knowledge_queue WHERE state = 'queued' ORDER BY ts, id LIMIT 1",
				)
				.get() as { id: number } | null) ?? null
		);
	}

	async claim(id: number): Promise<KnowledgeJob | null> {
		const row = this.db
			.query(
				"SELECT source, payload, attempts, domain, area, code_origin, origin_sid, source_ref, source_hash, hub_eligible FROM knowledge_queue WHERE id = ? AND state = 'queued'",
			)
			.get(id) as
			| {
					source: string;
					payload: string;
					attempts: number;
					domain: string | null;
					area: string | null;
					code_origin: string | null;
					origin_sid: string | null;
					source_ref: string | null;
					source_hash: string | null;
					hub_eligible: 0 | 1 | null;
			  }
			| undefined;
		if (!row) return null;
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'started', attempts = attempts + 1, started_at = ? WHERE id = ?",
			)
			.run(Date.now(), id);
		return {
			id,
			source: row.source,
			payload: row.payload,
			attempts: row.attempts + 1,
			domain: row.domain,
			area: row.area,
			// W100: the enqueue-normalized ref IS the fallback provenance — the
			// substitution gate writes it verbatim when nothing better resolves,
			// so rows carry "path" not "path — explanation".
			codeOrigin: row.source_ref ?? row.code_origin,
			originSid: row.origin_sid,
			sourceRef: row.source_ref,
			// W100: the enqueue-time FILE hash passes through verbatim; "" means
			// the producer stored NULL (unresolvable at enqueue) — upsert() turns
			// that into a NULL row hash so /verify never chases a doomed value.
			sourceHash: row.source_hash ?? "",
			hubEligible: row.hub_eligible,
		};
	}

	async complete(
		id: number,
		ledger: { written: number[]; skipped: string[] },
		domain: string | null,
		by: string | null,
	): Promise<void> {
		// W244: the parser stamp + payload retention make done rows re-ingestable
		// — the reprocess checkpoint re-enqueues them exactly once per prompt
		// version (reprocessCheck). Payload was cleared pre-W244; those rows are
		// marked-and-skipped honestly by the checkpoint.
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'done', result_key = ?, prompt_hash = ? WHERE id = ?",
			)
			.run(JSON.stringify(ledger), currentPromptHash(), id);
		await this.emitLanded(domain, ledger.written, id, by);
	}

	async fail(id: number, err: string, poison: boolean): Promise<void> {
		if (poison) {
			this.db
				.query(
					"UPDATE knowledge_queue SET state = 'failed', result_key = ?, payload = '' WHERE id = ?",
				)
				.run(`failed after max attempts: ${err.slice(0, 250)}`, id);
			// W244: a poisoned REPROCESS copy re-arms its archived parent — the
			// next prompt evolution re-ingests the source; the failed copy stays
			// dead. Without this, a dead copy would orphan the only payload.
			const row = this.db
				.query("SELECT reprocess_of FROM knowledge_queue WHERE id = ?")
				.get(id) as { reprocess_of: number | null } | undefined;
			if (row?.reprocess_of)
				this.db
					.query(
						"UPDATE knowledge_queue SET reprocessed_at = NULL WHERE id = ?",
					)
					.run(row.reprocess_of);
		} else
			this.db
				.query("UPDATE knowledge_queue SET state = 'queued' WHERE id = ?")
				.run(id);
	}

	async promote(id: number): Promise<boolean> {
		return (
			this.db
				.query(
					"UPDATE knowledge SET state = 'active' WHERE id = ? AND state = 'candidate'",
				)
				.run(id).changes > 0
		);
	}

	async retire(id: number, supersededBy: number | null): Promise<boolean> {
		return (
			this.db
				.query(
					"UPDATE knowledge SET state = 'retired', superseded_by = COALESCE(?, superseded_by) WHERE id = ? AND state != 'retired'",
				)
				.run(supersededBy, id).changes > 0
		);
	}

	// W836: stamp the audit trust fields {rating, evidence, researched_at} —
	// provenance rides a contributors note; absent fields keep old values.
	async grade(
		id: number,
		fields: {
			rating?: string | null;
			evidence?: string | null;
			researchedAt?: number | null;
		},
		by?: string,
	): Promise<boolean> {
		const cur = this.db
			.query(
				"SELECT id FROM knowledge WHERE id = ? AND state NOT IN ('retired','graveyard')",
			)
			.get(id);
		if (!cur) return false;
		this.db
			.query(
				"UPDATE knowledge SET rating = COALESCE(?, rating), evidence = COALESCE(?, evidence), researched_at = COALESCE(?, researched_at) WHERE id = ?",
			)
			.run(
				fields.rating ?? null,
				fields.evidence ?? null,
				fields.researchedAt ?? null,
				id,
			);
		this.appendNote(
			id,
			by ?? "audit",
			`grade: rating=${fields.rating ?? "keep"} evidence=${fields.evidence ?? "keep"} researched=${fields.researchedAt ? new Date(fields.researchedAt).toISOString().slice(0, 10) : "keep"} (W836)`,
		);
		return true;
	}

	// W836: bury a rejected/integrity-flagged row — state='graveyard' with the
	// reason ON the row; append-only (never DELETE). Excluded from recall
	// ranking and curation scans; a correction is a NEW row (supersedes_id).
	async graveyard(id: number, reason: string, by?: string): Promise<boolean> {
		const ok =
			this.db
				.query(
					"UPDATE knowledge SET state = 'graveyard', graveyard_reason = ? WHERE id = ? AND state != 'graveyard'",
				)
				.run(reason.slice(0, 300), id).changes > 0;
		if (!ok) return false;
		this.appendNote(
			id,
			by ?? "audit",
			`graveyard: ${reason.slice(0, 300)} (W836)`,
		);
		this.emitCurate("knowledge.graveyard", by ?? "audit", {
			knowledge: id,
			reason: reason.slice(0, 300),
		});
		return true;
	}

	async note(id: number, sid: string, what: string): Promise<number> {
		const row = this.db
			.query("SELECT contributors FROM knowledge WHERE id = ?")
			.get(id) as { contributors: string | null } | undefined;
		if (!row) return -1;
		let contributors: unknown[] = [];
		try {
			contributors = row.contributors ? JSON.parse(row.contributors) : [];
		} catch {}
		contributors.push({ sid, ts: Date.now(), what });
		this.db
			.query(
				"UPDATE knowledge SET contributors = ?, updated_at = ? WHERE id = ?",
			)
			.run(JSON.stringify(contributors), Date.now(), id);
		return contributors.length;
	}

	async verifyRows(id: number | null) {
		return this.db
			.query(
				"SELECT id, topic, source_ref AS sourceRef, source_hash AS sourceHash FROM knowledge WHERE source_ref IS NOT NULL AND source_hash IS NOT NULL AND (? IS NULL OR id = ?)",
			)
			.all(id, id) as {
			id: number;
			topic: string;
			sourceRef: string;
			sourceHash: string;
		}[];
	}

	// W103: substitution curation — flag single-file-derivable rows for HUMAN
	// review. Rows stay in place; the flag is a contributors note appended
	// WITHOUT bumping updated_at (a flag is not a freshness signal).
	async curate(opts: { repoRoot: string; by?: string }): Promise<{
		checked: number;
		flagged: { id: number; topic: string; doc: string; coverage: number }[];
	}> {
		const docs = [...loadDocs(opts.repoRoot), ...loadRootDocs(opts.repoRoot)];
		const rows = this.db
			.query(
				"SELECT id, topic, fact, source_ref FROM knowledge WHERE state NOT IN ('retired', 'graveyard')",
			)
			.all() as {
			id: number;
			topic: string;
			fact: string;
			source_ref: string | null;
		}[];
		const flagged: {
			id: number;
			topic: string;
			doc: string;
			coverage: number;
		}[] = [];
		return this.curateScan(opts, docs, rows, flagged);
	}

	private curateScan(
		opts: { repoRoot: string; by?: string },
		docs: SubstitutionDoc[],
		rows: {
			id: number;
			topic: string;
			fact: string;
			source_ref: string | null;
		}[],
		flagged: { id: number; topic: string; doc: string; coverage: number }[],
	): {
		checked: number;
		flagged: { id: number; topic: string; doc: string; coverage: number }[];
	} {
		for (const r of rows) {
			const own = docForRef(opts.repoRoot, r.source_ref);
			const corpus = own ? [...docs, own] : docs;
			const v = substitutionCheck(r.fact, corpus);
			if (!v.covered) continue;
			flagged.push({
				id: r.id,
				topic: r.topic,
				doc: v.doc ?? "?",
				coverage: Math.round(v.coverage * 100),
			});
		}
		this.curateRecord(opts, rows, flagged);
		return { checked: rows.length, flagged };
	}

	// contributors append WITHOUT updated_at bump (unlike note())
	private appendNote(id: number, sid: string, what: string): void {
		const row = this.db
			.query("SELECT contributors FROM knowledge WHERE id = ?")
			.get(id) as { contributors: string | null } | undefined;
		if (!row) return;
		let list: unknown[] = [];
		try {
			list = row.contributors ? JSON.parse(row.contributors) : [];
		} catch {}
		list.push({ sid, ts: Date.now(), what });
		this.db
			.query("UPDATE knowledge SET contributors = ? WHERE id = ?")
			.run(JSON.stringify(list), id);
	}

	// one knowledge-plane bus event (the curateRecord INSERT shape; scope
	// fixed to 'knowledge' — source names the actor: worker or human)
	private emitCurate(
		kind: string,
		by: string,
		payload: Record<string, unknown>,
	): void {
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, 'knowledge', ?, NULL)",
			)
			.run(Date.now(), by, kind, JSON.stringify(payload));
	}

	// flag notes + one plane event (curateScan part 2; `by` names the curator)
	private curateRecord(
		opts: { repoRoot: string; by?: string },
		rows: unknown[],
		flagged: { id: number; topic: string; doc: string; coverage: number }[],
	): void {
		const by = opts.by ?? "curate";
		for (const f of flagged) {
			this.appendNote(
				f.id,
				by,
				`curate-flag: single-file-derivable from ${f.doc} (${f.coverage}% term coverage) — pointer-ize or retire (W103)`,
			);
		}
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.curate', 'knowledge', ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				JSON.stringify({
					repo: opts.repoRoot,
					by,
					checked: rows.length,
					flagged: flagged.map((f) => f.id),
				}),
			);
	}

	async upsert(row: KnowledgeUpsert): Promise<number> {
		const now = Date.now();
		// W953 doctrine: a distilled row is a SINGLE-MODEL pass — the distiller
		// self-assesses 0..1, but 0.8+ claims model-reviewed/consensus bands a
		// first stamp can never make (makeStamp throws → the job fails and the
		// payload poisons). Stamp (and store) at the single-model anchor 0.6 —
		// the consult-answer precedent — a low model value keeps its machine
		// band. Independent review raises the stamp later, with evidence.
		const value = Math.max(CONFIDENCE_MIN, Math.min(row.confidence, 0.6));
		const stamp = makeStamp({
			value,
			setter: "mechanical:knowledge-worker",
			evidence: row.sourceRef ?? undefined,
		});
		const ins = this.db
			.query(
				"INSERT INTO knowledge (ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, created_at, updated_at, hub_eligible, confidence_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'knowledge-worker', 'candidate', ?, ?, ?, ?)",
			)
			.run(
				now,
				row.topic,
				row.fact,
				value,
				row.domain,
				row.area,
				row.originKind,
				row.originSystem,
				row.sourceRef,
				row.originSid,
				JSON.stringify(
					row.originSid
						? [{ sid: row.originSid, ts: now, what: "origin" }]
						: [],
				),
				// supersedes links must point at REAL rows — never dangle
				row.supersedesId &&
					this.db
						.query("SELECT 1 FROM knowledge WHERE id = ?")
						.get(row.supersedesId)
					? row.supersedesId
					: null,
				row.sourceRef,
				// W100: "" (unhashable at enqueue) lands as NULL — /verify only ever
				// compares against a hash the producer actually took of the file.
				row.sourceHash || null,
				now,
				now,
				row.hubEligible ?? null,
				JSON.stringify(stamp),
			);
		return Number(ins.lastInsertRowid);
	}

	async dedupeCheck(cand: {
		topic: string;
		fact: string;
	}): Promise<{ id: number; topic: string; fact: string } | null> {
		return findNearDuplicate(this.db, cand);
	}

	async search(filters: KnowledgeSearchFilters): Promise<KnowledgeHit[]> {
		return knowledgeSearch(this.db, filters.query, filters);
	}

	async emitLanded(
		domain: string | null,
		written: number[],
		queueId: number,
		by: string | null,
	): Promise<void> {
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.landed', ?, ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				domain,
				JSON.stringify({ knowledge: written, queue: queueId, by }),
			);
	}

	// W246: ONE event row per near-dup firing — payload carries both sides
	// (X candidate, Y near-dup row) so the human disposes from the bus
	// without re-deriving the match. Append-only; no row state changes here.
	async proposeSupersession(
		p: NearDupProposal,
		queueId: number,
		by: string | null,
	): Promise<void> {
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.dup-proposal', 'knowledge', ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				JSON.stringify({ queue: queueId, by, ...p }),
			);
	}

	async recoverOrphans(olderThanMs: number): Promise<void> {
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'queued' WHERE state IN ('started','running') AND started_at < ?",
			)
			.run(Date.now() - olderThanMs);
	}

	async queuedCount(): Promise<number> {
		return (
			this.db
				.query(
					"SELECT COUNT(*) AS n FROM knowledge_queue WHERE state = 'queued'",
				)
				.get() as { n: number }
		).n;
	}

	// W166: hub_eligible stamp on BOTH the queue row and the distilled rows —
	// idempotent (hub_eligible IS NULL guard), matching the W159 settle SQL.
	// Counts ride pre-SELECTs: bun's stmt.changes on an UPDATE that fires the
	// FTS sync trigger reports trigger/FTS ops too — never the honest delta.
	async settleHubEligible(
		sid: string,
		flag: 0 | 1,
	): Promise<{ queueMarked: number; rowsBackfilled: number }> {
		const pending = (t: string): number =>
			Number(
				(
					this.db
						.query(
							`SELECT COUNT(*) AS n FROM ${t} WHERE origin_sid = ? AND hub_eligible IS NULL`,
						)
						.get(sid) as { n: number }
				).n,
			);
		const queueMarked = pending("knowledge_queue");
		const rowsBackfilled = pending("knowledge");
		this.db
			.query(
				"UPDATE knowledge_queue SET hub_eligible = ? WHERE origin_sid = ? AND hub_eligible IS NULL",
			)
			.run(flag, sid);
		this.db
			.query(
				"UPDATE knowledge SET hub_eligible = ? WHERE origin_sid = ? AND hub_eligible IS NULL",
			)
			.run(flag, sid);
		return { queueMarked, rowsBackfilled };
	}

	// W381 (from parked/W208) decay sweep: score every non-retired row through
	// the pure planner (./knowledge-curate.ts) and write the result — insert
	// open proposals, refresh scores that moved, auto-close recovered rows
	// ('stale'). The writes live in proposeWrite.
	async proposeDecay(opts: DecayOpts = {}): Promise<DecaySweep> {
		const rows = this.db
			.query(
				"SELECT id, topic, confidence, state, ts, updated_at FROM knowledge WHERE state NOT IN ('retired', 'graveyard')",
			)
			.all() as CurateRow[];
		const open = this.db
			.query(
				"SELECT id, knowledge_id, score FROM knowledge_proposals WHERE state = 'open'",
			)
			.all() as OpenProposal[];
		const dismissals = this.db
			.query(
				"SELECT knowledge_id, MAX(decided_at) AS decided_at FROM knowledge_proposals WHERE state = 'dismissed' AND decided_at IS NOT NULL GROUP BY knowledge_id",
			)
			.all() as Dismissal[];
		return this.proposeWrite(
			planDecayProposals(rows, open, dismissals, opts),
			opts.by,
		);
	}

	// proposeDecay part 2 — the writes. Notes ride appendNote: NO updated_at
	// bump (a proposal is evidence, not freshness — the curate() doctrine).
	private proposeWrite(plan: DecayPlan, by?: string): DecaySweep {
		const now = Date.now();
		for (const p of plan.refresh)
			this.db
				.query(
					"UPDATE knowledge_proposals SET score = ?, ts = ?, reason = ? WHERE id = ? AND state = 'open'",
				)
				.run(p.score, now, p.reason, p.proposalId);
		for (const pid of plan.stale)
			this.db
				.query(
					"UPDATE knowledge_proposals SET state = 'stale', decided_at = ? WHERE id = ? AND state = 'open'",
				)
				.run(now, pid);
		for (const p of plan.propose) {
			this.db
				.query(
					"INSERT INTO knowledge_proposals (ts, knowledge_id, kind, score, age_days, confidence, reason, state) VALUES (?, ?, 'retire', ?, ?, ?, ?, 'open')",
				)
				.run(now, p.knowledgeId, p.score, p.ageDays, p.confidence, p.reason);
			this.appendNote(
				p.knowledgeId,
				by ?? "decay-sweep",
				`decay proposal: ${p.reason} — dispose pending (W208)`,
			);
		}
		if (plan.propose.length || plan.stale.length)
			this.emitCurate("knowledge.propose", by ?? "decay-sweep", {
				proposed: plan.propose.map((p) => p.knowledgeId),
				refreshed: plan.refresh.length,
				stale: plan.stale,
			});
		return {
			checked: plan.checked,
			proposed: plan.propose,
			refreshed: plan.refresh.length,
			stale: plan.stale.length,
		};
	}
	// W208 read side of the human dispose surface: proposals joined with
	// their knowledge rows, worst score first; state='all' skips the filter.
	async listProposals(state = "open"): Promise<KnowledgeProposalView[]> {
		const where = state === "all" ? "1=1" : "p.state = ?";
		const params = state === "all" ? [] : [state];
		return this.db
			.query(
				`SELECT p.id, p.knowledge_id AS knowledgeId, p.state, p.score, p.age_days AS ageDays, p.reason, p.ts, p.decided_by AS decidedBy, p.decided_at AS decidedAt, k.topic, k.fact FROM knowledge_proposals p JOIN knowledge k ON k.id = p.knowledge_id WHERE ${where} ORDER BY p.score, p.id`,
			)
			.all(...params) as KnowledgeProposalView[];
	}
	// W208 write side of the human dispose: the ONLY path from proposal to
	// row mutation. approve retires the knowledge row (guarded against
	// double-retire); dismiss records the verdict — its decided_at starts
	// the re-propose cooldown. The state='open' guard makes a double
	// dispose an honest no-op.
	async disposeProposal(
		id: number,
		decision: "approve" | "dismiss",
		opts: { by?: string; note?: string; supersededBy?: number | null } = {},
	): Promise<{ ok: boolean; retired: boolean }> {
		const row = this.db
			.query(
				"SELECT knowledge_id FROM knowledge_proposals WHERE id = ? AND state = 'open'",
			)
			.get(id) as { knowledge_id: number } | undefined;
		if (!row) return { ok: false, retired: false };
		const by = opts.by ?? "human";
		this.db
			.query(
				"UPDATE knowledge_proposals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?",
			)
			.run(
				decision === "approve" ? "approved" : "dismissed",
				by,
				Date.now(),
				id,
			);
		let retired = false;
		if (decision === "approve")
			retired =
				this.db
					.query(
						"UPDATE knowledge SET state = 'retired', superseded_by = COALESCE(?, superseded_by) WHERE id = ? AND state != 'retired'",
					)
					.run(opts.supersededBy ?? null, row.knowledge_id).changes > 0;
		this.appendNote(
			row.knowledge_id,
			by,
			`disposed: ${decision}${opts.note ? ` — ${opts.note}` : ""}${retired ? " (row retired)" : ""} (W208)`,
		);
		this.emitCurate("knowledge.dispose", by, {
			proposal: id,
			knowledge: row.knowledge_id,
			decision,
			retired,
		});
		return { ok: true, retired };
	}
	// W166: merge FTS5 segments — keeps the index bounded from row one.
	async optimize(): Promise<void> {
		this.db
			.query("INSERT INTO knowledge_fts (knowledge_fts) VALUES ('optimize')")
			.run();
	}

	// W244 — parser-change reprocess checkpoint: done rows distilled under an
	// older parser than `cur` re-enqueue EXACTLY ONCE. apply=false is a
	// read-only dry-run (would-counts only — nothing is written or advanced).
	reprocessCheck(cur: string, apply: boolean): Promise<ReprocessReport> {
		return this.reprocessApplyTx(cur, apply);
	}

	// reprocessApplyTx part 1 — read the checkpoint, count the affected done
	// rows, dry-run the would-counts or hand to the apply transaction.
	private async reprocessApplyTx(
		cur: string,
		apply: boolean,
	): Promise<ReprocessReport> {
		const cpAt = (): string | null =>
			(
				this.db
					.query("SELECT prompt_hash FROM queue_checkpoint WHERE id = 1")
					.get() as { prompt_hash: string | null } | undefined
			)?.prompt_hash ?? null;
		const report: ReprocessReport = {
			current: cur,
			checkpoint: cpAt(),
			advanced: false,
			requeued: 0,
			marked: 0,
			skippedNoPayload: 0,
		};
		if (report.checkpoint === cur) return report; // current parser — no-op
		const scan = this.db
			.query(
				"SELECT id, payload FROM knowledge_queue WHERE state = 'done' AND reprocessed_at IS NULL AND (prompt_hash IS NULL OR prompt_hash != ?) ORDER BY id",
			)
			.all(cur) as { id: number; payload: string }[];
		if (!apply) {
			for (const r of scan)
				if (r.payload) report.requeued++;
				else report.skippedNoPayload++;
			report.marked = scan.length; // would-count: every scanned row gets marked
			return report;
		}
		return this.reprocessCommitTx(cur, scan, report, cpAt);
	}

	// reprocessApplyTx part 2 — the exactly-once anchor: ONE BEGIN IMMEDIATE
	// transaction marks the archive, enqueues the reprocess copies and
	// advances the checkpoint; the in-tx re-check kills the worker/CLI race.
	private async reprocessCommitTx(
		cur: string,
		scan: { id: number; payload: string }[],
		report: ReprocessReport,
		cpAt: () => string | null,
	): Promise<ReprocessReport> {
		this.db.run("BEGIN IMMEDIATE");
		try {
			// a racing applier may have advanced the checkpoint between the scan
			// and the lock — then the pass no-ops (still exactly once)
			if (cpAt() === cur) {
				this.db.run("COMMIT");
				return report;
			}
			this.reprocessRows(scan, report);
			this.db
				.query(
					"INSERT INTO queue_checkpoint (id, prompt_hash, ts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET prompt_hash = excluded.prompt_hash, ts = excluded.ts",
				)
				.run(cur, Date.now());
			this.db.run("COMMIT");
			report.advanced = true;
		} catch (e) {
			try {
				this.db.run("ROLLBACK");
			} catch {}
			throw e;
		}
		return this.reprocessEvent(cur, report);
	}

	// reprocessCommitTx part 2 — one plane event per advancing pass
	private reprocessEvent(
		cur: string,
		report: ReprocessReport,
	): ReprocessReport {
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.reprocess', 'knowledge', ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				JSON.stringify({
					from: report.checkpoint,
					to: cur,
					requeued: report.requeued,
					marked: report.marked,
					skipped: report.skippedNoPayload,
				}),
			);
		return report;
	}

	private reprocessRows(
		scan: { id: number; payload: string }[],
		report: ReprocessReport,
	): void {
		for (const r of scan) {
			const marked = this.db
				.query(
					"UPDATE knowledge_queue SET reprocessed_at = ? WHERE id = ? AND reprocessed_at IS NULL",
				)
				.run(Date.now(), r.id).changes;
			if (!marked) continue; // racing applier marked it first — never twice
			report.marked++;
			if (!r.payload) {
				report.skippedNoPayload++;
				continue;
			}
			this.db
				.query(
					"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, domain, area, code_origin, origin_sid, source_ref, source_hash, reprocess_of) SELECT ?, source, payload, 'queued', 0, domain, area, code_origin, origin_sid, source_ref, source_hash, ? FROM knowledge_queue WHERE id = ?",
				)
				.run(Date.now(), r.id, r.id);
			report.requeued++;
		}
	}
}
