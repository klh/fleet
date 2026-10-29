// hooks/lib/store-schema.ts — the knowledge layer's port types (W91 #9):
// the KnowledgeStore contract a worker loop consumes and the row/queue
// shapes that cross it. Split from knowledge-ports.ts (W1255.3); the SQLite
// adapter lives in ./sqlite-store.ts, the distill clients in
// ./distill-clients.ts, the prompt policy in ./prompt-policy.ts.
import type { KnowledgeHit } from "./knowledge.ts";
import type { DecayOpts, ProposalDraft } from "./knowledge-curate.ts";

export type { KnowledgeHit };

export interface KnowledgeJob {
	id: number;
	source: string;
	payload: string;
	attempts: number;
	domain: string | null;
	area: string | null;
	// W100: the producer-declared provenance (normalized at enqueue) — claim()
	// surfaces it INSTEAD of the raw code_origin hint so the substitution
	// gate's fallback writes a resolvable ref, not "path — explanation" prose.
	codeOrigin: string | null;
	originSid: string | null;
	sourceRef: string | null;
	// W100: enqueue-time sha256 of the source_ref FILE (producer had repo
	// access; the distiller only sees the payload) — never the payload hash.
	// "" when the producer stored NULL (ref unresolvable there); upsert()
	// lands "" as NULL so the trust marker stays honest.
	sourceHash: string;
	/** W159: the queue row's settled hub_eligible (NULL = unsettled) —
	 *  inherited by distilled rows so feed timing cannot orphan the sort. */
	hubEligible: 0 | 1 | null;
}

export interface KnowledgeUpsert {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	sourceRef: string | null;
	// W100: the enqueue-time FILE hash from the queue (claim() maps NULL to
	// ""). upsert() lands ""/NULL as a NULL row hash — never a doomed value.
	sourceHash: string | null;
	originSid: string | null;
	/** W159 provenance sort: stamp distilled rows from the queue row's
	 *  settled flag (inheritance at distill; the settle backfills the rest). */
	hubEligible?: 0 | 1 | null;
	supersedesId: number | null;
}

/** W246 near-dup propose-dispose: one firing of the ingest dedupe gate. The
 *  skip stands (older kept); the proposal records the skipped candidate (X)
 *  against the near-dup row (Y) so a human can dispose — retire Y
 *  superseded-by X if X is the correction. Append-only: ledger + one event. */
export interface NearDupProposal {
	/** the existing near-dup row the proposal would retire */
	y: number;
	yTopic: string;
	/** the skipped candidate's topic/fact (already secret-redacted) */
	xTopic: string;
	xFact: string;
	/** the disposal a human would execute on confirmation */
	action: string;
}

export interface KnowledgeSearchFilters {
	query: string;
	limit?: number;
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
}

// W381 (from parked/W208): one knowledge_proposals row joined with its
// knowledge row — the human dispose surface reads these.
export interface KnowledgeProposalView {
	id: number;
	knowledgeId: number;
	state: string;
	score: number;
	ageDays: number;
	reason: string;
	ts: number;
	decidedBy: string | null;
	decidedAt: number | null;
	topic: string;
	fact: string;
}

// W381 (from parked/W208): one decay sweep's outcome — proposed are the
// drafts written open.
export interface DecaySweep {
	checked: number;
	proposed: ProposalDraft[];
	refreshed: number;
	stale: number;
}

export interface KnowledgeStore {
	// queue semantics (directive #8 shape stays a worker-loop concern; the
	// store only guarantees claim/complete/fail)
	peekNext(): Promise<{ id: number } | null>;
	claim(id: number): Promise<KnowledgeJob | null>;
	complete(
		id: number,
		ledger: {
			written: number[];
			skipped: string[];
			proposals?: NearDupProposal[];
		},
		domain: string | null,
		by: string | null,
	): Promise<void>;
	fail(id: number, err: string, poison: boolean): Promise<void>;
	// storage + retrieval
	upsert(row: KnowledgeUpsert): Promise<number>;
	dedupeCheck(cand: {
		topic: string;
		fact: string;
	}): Promise<{ id: number; topic: string; fact: string } | null>;
	search(filters: KnowledgeSearchFilters): Promise<KnowledgeHit[]>;
	emitLanded(
		domain: string | null,
		written: number[],
		queueId: number,
		by: string | null,
	): Promise<void>;
	// W246: one supersession-proposal event row per near-dup firing
	proposeSupersession(
		p: NearDupProposal,
		queueId: number,
		by: string | null,
	): Promise<void>;
	recoverOrphans(olderThanMs: number): Promise<void>;
	queuedCount(): Promise<number>;
	// lifecycle (human/merge-gated; mechanical micro-updates)
	promote(id: number): Promise<boolean>;
	retire(id: number, supersededBy: number | null): Promise<boolean>;
	note(id: number, sid: string, what: string): Promise<number>;
	// W836 audit trust schema: grade stamps {rating, evidence, researched_at}
	// on a row (audit-lane provenance note rides along); graveyard buries a
	// rejected/integrity-flagged row with its reason — NEVER a delete, and
	// recall ranking excludes the state.
	grade(
		id: number,
		fields: {
			rating?: string | null;
			evidence?: string | null;
			researchedAt?: number | null;
		},
		by?: string,
	): Promise<boolean>;
	graveyard(id: number, reason: string, by?: string): Promise<boolean>;
	verifyRows(
		id: number | null,
	): Promise<
		{ id: number; topic: string; sourceRef: string; sourceHash: string }[]
	>;
	// W103 curation: flag rows failing the substitution test for HUMAN review.
	// Rows stay in place, state untouched — a contributors note records the
	// verdict (append-only, NO updated_at bump: flagging is not freshness).
	curate(opts: { repoRoot: string; by?: string }): Promise<{
		checked: number;
		flagged: {
			id: number;
			topic: string;
			doc: string;
			coverage: number;
		}[];
	}>;
	// W166: the W159 settle's provenance sort rides the PORT — the settle's
	// knowledge writes must go through knowledge.db, never openGovernorDb.
	settleHubEligible(
		sid: string,
		flag: 0 | 1,
	): Promise<{ queueMarked: number; rowsBackfilled: number }>;
	// W166 (design §4): FTS5 segment merge after every job that wrote rows —
	// measured 70 ms per run, ~5% read-latency recovery after churn.
	optimize(): Promise<void>;
	// W244 — parser-change reprocess checkpoint. `cur` = active distill-prompt
	// hash; done rows processed under an older parser re-enqueue EXACTLY ONCE.
	// apply=false is a read-only dry-run (would-counts only, no writes).
	reprocessCheck(cur: string, apply: boolean): Promise<ReprocessReport>;
	// W381 (from parked/W208) curation engine: recency decay → propose →
	// human dispose. The sweep only proposes (one open proposal per row;
	// recovered rows auto-close 'stale'); disposeProposal is the only path
	// to a row mutation.
	proposeDecay(opts?: DecayOpts): Promise<DecaySweep>;
	listProposals(state?: string): Promise<KnowledgeProposalView[]>;
	disposeProposal(
		id: number,
		decision: "approve" | "dismiss",
		opts?: { by?: string; note?: string; supersededBy?: number | null },
	): Promise<{ ok: boolean; retired: boolean }>;
}

// W244 — outcome of one reprocessCheck pass. requeued/marked are did-counts
// when applied, would-counts on a dry-run; checkpoint = the stored hash the
// pass compared against (null = no checkpoint yet); advanced = the checkpoint
// moved this pass.
export interface ReprocessReport {
	current: string;
	checkpoint: string | null;
	advanced: boolean;
	requeued: number;
	marked: number;
	/** legacy rows whose payload was cleared pre-W244 — marked so they never
	 *  re-fire, honestly NOT re-ingestable (source text is gone). */
	skippedNoPayload: number;
}
