// hooks/lib/knowledge-consolidate.ts — W1227: the knowledge consolidation
// flow. The ingest worker owns INSERT; this sweep consolidates what already
// landed: deterministic term overlap pairs live rows and PROPOSES — it never
// auto-deletes (similarity is not authority; the CrewAI consolidation bug:
// eager merges dropped source + private), and every executed update carries
// the row's provenance forward mechanically: the apply UPDATE's SET clause
// lists only `fact` (+ version) — source/source_ref/source_hash/origin_sid
// ride untouched. Competing explanations — similar pairs where BOTH sides are
// promoted/graded — are retained and reported, never proposed against: only a
// human disposing with evidence resolves them.
//
// Split like knowledge-curate.ts: the planner is pure (tests run it without a
// database); consolidateSweep/consolidateDisposeTx own the SQL. No inference
// leg today; when one lands it rides the Buckle route (knowledgeBuckleRoute)
// — never a direct provider call (fleet law: inference via buckle only).
//
// CAS doctrine (facts.ts casWrite precedent): a proposal stamps the
// COALESCE(version, 1) of both rows at mint; the approve re-reads both rows
// inside ONE BEGIN IMMEDIATE and refuses — flipping the proposal 'stale' —
// when either version moved. Deletion is a retire (append-only doctrine:
// graveyards never delete), superseded-by the winner.
import { DECAY_DISMISS_COOLDOWN_DAYS } from "./knowledge-curate.ts";

// band thresholds: Jaccard over the consolidated token set (findNearDuplicate
// token doctrine). ≥ delete band = a restatement; update band = partial
// overlap worth merging; below = distinct, nothing proposed.
export const CONSOLIDATE_DELETE_MIN = 0.75;
export const CONSOLIDATE_UPDATE_MIN = 0.45;
// the sweep is bounded: a corpus past this many live rows is reported, not
// swept (streams-over-buffers law: bounded, inspectable work units)
export const CONSOLIDATE_MAX_ROWS = 2000;
// a dismissed consolidation proposal cools down per row before re-proposal
export const CONSOLIDATE_DISMISS_COOLDOWN_DAYS = DECAY_DISMISS_COOLDOWN_DAYS;

export interface ConsolidateRow {
	id: number;
	topic: string;
	fact: string;
	confidence: number;
	state: string;
	ts: number;
	updatedAt: number | null;
	version: number;
	source: string | null;
	sourceRef: string | null;
	sourceHash: string | null;
	originSid: string | null;
	rating: string | null;
	researchedAt: number | null;
}

// the provenance a consolidation MUST carry forward — the CrewAI update bug
// (dropping source + private) is regression-guarded by the apply UPDATE's SET
// clause never listing these columns
export interface ConsolidationProvenance {
	source: string | null;
	sourceRef: string | null;
	sourceHash: string | null;
	originSid: string | null;
}

// the provenance of a row, as the proposal's carry payload records it
export function provenanceOf(r: ConsolidateRow): ConsolidationProvenance {
	return {
		source: r.source,
		sourceRef: r.sourceRef,
		sourceHash: r.sourceHash,
		originSid: r.originSid,
	};
}

// deterministic pair direction: an evidence-backed row (audit grade: research
// date or rating present) outranks a plain row; then confidence; then the row
// touched most recently. The same pair always classifies the same direction.
export function consolidateBetter(
	x: ConsolidateRow,
	y: ConsolidateRow,
): boolean {
	const ex = x.researchedAt != null || (x.rating ?? "") !== "";
	const ey = y.researchedAt != null || (y.rating ?? "") !== "";
	if (ex !== ey) return ex;
	if (x.confidence !== y.confidence) return x.confidence > y.confidence;
	return (x.updatedAt ?? x.ts) >= (y.updatedAt ?? y.ts);
}

// tokens + Jaccard: the mechanical similarity the whole flow proposes on —
// same token doctrine as findNearDuplicate (>2-char, lowercase)
export function consolidateTokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/)
			.filter((t) => t.length > 2),
	);
}

export function jaccardOverlap(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

// the merged fact an update proposal applies verbatim on approve — carried
// text, never a rewrite (similarity is not authority; the human approved THIS
// text)
export function consolidatedFact(
	winner: ConsolidateRow,
	loser: ConsolidateRow,
): string {
	return `${winner.fact} | ${loser.fact}`.slice(0, 900);
}

export type ConsolidationAction = "delete" | "update";

// one proposal the sweep wants written. `nominee` is the LOSER — the row the
// action acts on (retire, or merge-then-retire); `winner` survives. `payload`
// is the JSON that rides knowledge_proposals.payload verbatim.
export interface ConsolidationDraft {
	action: ConsolidationAction;
	nominee: ConsolidateRow;
	winner: ConsolidateRow;
	sim: number;
	mergedFact: string | null;
	payload: string;
	reason: string;
}

export interface CompetingPair {
	aId: number;
	aTopic: string;
	bId: number;
	bTopic: string;
	sim: number;
}

export interface ConsolidationPlan {
	checked: number;
	pairs: number;
	propose: ConsolidationDraft[];
	retainedCompeting: CompetingPair[];
}

export interface ConsolidateOpts {
	now?: number;
	minUpdate?: number;
	minDelete?: number;
	cooldownDays?: number;
}

// the sweep's full outcome (plan + write counts)
export interface ConsolidationSweep extends ConsolidationPlan {
	overCap: boolean;
	skipped: number;
}

// a proposal row the sweep must respect: open proposals block, fresh
// dismissals cool down
export interface ConsolidateBlocked {
	open: Set<number>;
	dismissedAt: Map<number, number>;
}

// one pair's classification: what the bands say when open proposals and the
// dismiss cooldown do not block the loser.
export interface PairVerdict {
	action: ConsolidationAction | "retain";
	winner: ConsolidateRow;
	loser: ConsolidateRow;
	sim: number;
	mergedFact: string | null;
}

// classify one pair (pure): dup band → delete; partial band merges only when
// one side is an unpromoted candidate — two promoted rows overlapping are
// competing explanations, retained.
export function classifyPair(
	a: ConsolidateRow,
	b: ConsolidateRow,
	minUpdate: number,
	minDelete: number,
): PairVerdict {
	const sim = jaccardOverlap(
		consolidateTokens(`${a.topic} ${a.fact}`),
		consolidateTokens(`${b.topic} ${b.fact}`),
	);
	if (sim < minUpdate)
		return { action: "retain", winner: a, loser: b, sim, mergedFact: null };
	const winner = consolidateBetter(a, b) ? a : b;
	const loser = winner === a ? b : a;
	const dup = sim >= minDelete;
	const candidateSide = a.state === "candidate" || b.state === "candidate";
	const action: ConsolidationAction | "retain" = dup
		? "delete"
		: candidateSide
			? "update"
			: "retain";
	return {
		action,
		winner,
		loser,
		sim,
		mergedFact: action === "update" ? consolidatedFact(winner, loser) : null,
	};
}

const DAY_MS = 86_400_000;

// pairStep: fold one classified pair into the plan. `retain` verdicts that are
// genuinely similar (sim ≥ update floor) report as retainedCompeting — the
// CrewAI retention rule; below the floor they are distinct, silent skip.
// Propose verdicts respect the open-proposal block, the dismiss cooldown and
// the one-nomination-per-pass rule.
function pairStep(
	plan: ConsolidationPlan,
	v: PairVerdict,
	minUpdate: number,
	blocked: ConsolidateBlocked,
	nominated: Set<number>,
	now: number,
	cooldownMs: number,
): void {
	plan.pairs++;
	if (v.action === "retain") {
		if (v.sim < minUpdate) return; // distinct — silent skip
		plan.retainedCompeting.push({
			aId: v.winner.id,
			aTopic: v.winner.topic,
			bId: v.loser.id,
			bTopic: v.loser.topic,
			sim: v.sim,
		});
		return;
	}
	const loserId = v.loser.id;
	if (blocked.open.has(loserId) || nominated.has(loserId)) return;
	const at = blocked.dismissedAt.get(loserId);
	if (at !== undefined && now - at < cooldownMs) return;
	nominated.add(loserId);
	plan.propose.push(buildDraft(v));
}

// the whole sweep's decision, computed in memory — mirrors planDecayProposals:
// pair the rows, classify, respect the block map, never nominate a loser twice
// in one pass. O(n²) over the live corpus, bounded by CONSOLIDATE_MAX_ROWS.
export function planConsolidation(
	rows: ConsolidateRow[],
	blocked: ConsolidateBlocked,
	opts: ConsolidateOpts = {},
): ConsolidationPlan {
	const now = opts.now ?? Date.now();
	const minUpdate = opts.minUpdate ?? CONSOLIDATE_UPDATE_MIN;
	const minDelete = opts.minDelete ?? CONSOLIDATE_DELETE_MIN;
	const cooldownMs =
		(opts.cooldownDays ?? CONSOLIDATE_DISMISS_COOLDOWN_DAYS) * DAY_MS;
	const nominated = new Set<number>();
	const plan: ConsolidationPlan = {
		checked: rows.length,
		pairs: 0,
		propose: [],
		retainedCompeting: [],
	};
	let i = 0;
	for (const a of rows) {
		i++;
		for (const b of rows.slice(i))
			pairStep(
				plan,
				classifyPair(a, b, minUpdate, minDelete),
				minUpdate,
				blocked,
				nominated,
				now,
				cooldownMs,
			);
	}
	return plan;
}

// buildDraft: the proposal row fields for one verdict — the payload JSON
// rides knowledge_proposals.payload verbatim and is what approve executes
// under CAS. The carry block records both sides' provenance: the audit trail
// of what the merged row must retain (CrewAI source-drop regression guard).
function buildDraft(v: PairVerdict): ConsolidationDraft {
	const nominee = v.loser;
	const winner = v.winner;
	const reason =
		v.action === "delete"
			? `consolidate-delete: k#${nominee.id} restates k#${winner.id} (overlap ${v.sim.toFixed(2)}) — approve retires k#${nominee.id} superseded-by k#${winner.id}`
			: `consolidate-update: k#${nominee.id} overlaps k#${winner.id} (${v.sim.toFixed(2)}) — approve merges the residue into k#${winner.id} and retires k#${nominee.id} superseded-by k#${winner.id}; provenance carried forward`;
	const payload = JSON.stringify({
		action: v.action,
		nominee: { id: nominee.id, version: nominee.version },
		winner: { id: winner.id, version: winner.version },
		sim: v.sim,
		mergedFact: v.mergedFact,
		carry: { winner: provenanceOf(winner), loser: provenanceOf(nominee) },
	});
	return {
		action: v.action,
		nominee,
		winner,
		sim: v.sim,
		mergedFact: v.mergedFact,
		payload,
		reason,
	};
}

// ═══ store side — the sweep's SQL + the dispose execution ═══
// (the only new knowledge-row writer besides the ingest worker)

import type { Database } from "bun:sqlite";

// append-only provenance note, NO version bump (a proposal is evidence, not
// freshness — the class appendNote doctrine), no updated_at bump
function noteAppend(kb: Database, id: number, sid: string, what: string): void {
	const row = kb
		.query("SELECT contributors FROM knowledge WHERE id = ?")
		.get(id) as { contributors: string | null } | undefined;
	if (!row) return;
	let list: unknown[] = [];
	try {
		list = row.contributors ? JSON.parse(row.contributors) : [];
	} catch {}
	list.push({ sid, ts: Date.now(), what });
	kb.query("UPDATE knowledge SET contributors = ? WHERE id = ?").run(
		JSON.stringify(list),
		id,
	);
}

// one knowledge-plane bus event (scope 'knowledge', source names the actor)
function emitConsolidate(
	gov: Database | null,
	kind: string,
	by: string,
	payload: Record<string, unknown>,
): void {
	gov
		?.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, 'knowledge', ?, NULL)",
		)
		.run(Date.now(), by, kind, JSON.stringify(payload));
}

// load the live corpus (bounded) + the block map the planner respects
function sweepInputs(kb: Database): {
	rows: ConsolidateRow[];
	blocked: ConsolidateBlocked;
	overCap: boolean;
} {
	const rows = kb
		.query(
			"SELECT id, topic, fact, confidence, state, ts, updated_at AS updatedAt, COALESCE(version, 1) AS version, source, source_ref AS sourceRef, source_hash AS sourceHash, origin_sid AS originSid, rating, researched_at AS researchedAt FROM knowledge WHERE state NOT IN ('retired', 'graveyard') ORDER BY id LIMIT ?",
		)
		.all(CONSOLIDATE_MAX_ROWS + 1) as ConsolidateRow[];
	const overCap = rows.length > CONSOLIDATE_MAX_ROWS;
	if (overCap) rows.length = CONSOLIDATE_MAX_ROWS;
	return { rows, blocked: loadBlocked(kb), overCap };
}

// the block map: open proposals block a row, fresh dismissals cool it down
function loadBlocked(kb: Database): ConsolidateBlocked {
	const open = new Set<number>();
	const dismissedAt = new Map<number, number>();
	for (const r of kb
		.query(
			"SELECT knowledge_id AS id, MAX(decided_at) AS at FROM knowledge_proposals WHERE state = 'dismissed' AND decided_at IS NOT NULL GROUP BY knowledge_id",
		)
		.all() as { id: number; at: number }[])
		dismissedAt.set(r.id, r.at);
	for (const r of kb
		.query(
			"SELECT knowledge_id AS id FROM knowledge_proposals WHERE state = 'open'",
		)
		.all() as { id: number }[])
		open.add(r.id);
	return { open, dismissedAt };
}

// the propose-only sweep: plan → INSERT one proposal per draft (the partial
// unique index refuses doubles from a racing sweep — counted as skipped) →
// one plane event. Rows stay live; nothing here executes an action.
export function consolidateSweep(
	kb: Database,
	gov: Database | null,
	opts: ConsolidateOpts & { by?: string } = {},
): ConsolidationSweep {
	const inputs = sweepInputs(kb);
	const now = opts.now ?? Date.now();
	if (inputs.overCap)
		return {
			checked: inputs.rows.length,
			pairs: 0,
			propose: [],
			retainedCompeting: [],
			overCap: true,
			skipped: 0,
		};
	const plan = planConsolidation(inputs.rows, inputs.blocked, opts);
	return { ...plan, overCap: false, ...sweepWrite(kb, gov, plan, now, opts) };
}

// sweepWrite: the proposal INSERTs + the one plane event. A unique-index
// refusal (racing sweep or a classed row already holding an open proposal)
// is counted, never thrown — one firing never dies to a double-fire.
function sweepWrite(
	kb: Database,
	gov: Database | null,
	plan: ConsolidationPlan,
	now: number,
	opts: ConsolidateOpts & { by?: string },
): { skipped: number } {
	const by = opts.by ?? "consolidate-sweep";
	let skipped = 0;
	for (const d of plan.propose) {
		if (!writeDraft(kb, d, now, by)) skipped++;
	}
	if (plan.propose.length || plan.retainedCompeting.length)
		emitConsolidate(gov, "knowledge.consolidate", by, {
			proposed: plan.propose.map((d) => d.nominee.id),
			retained: plan.retainedCompeting.length,
			checked: plan.checked,
			pairs: plan.pairs,
		});
	return { skipped };
}

// writeDraft: one proposal INSERT; false = unique-index refusal (an open
// proposal already rides that row). Nominee note rides success — append-only.
function writeDraft(
	kb: Database,
	d: ConsolidationDraft,
	now: number,
	by: string,
): boolean {
	const ageDays = Math.max(
		0,
		Math.floor((now - (d.nominee.updatedAt ?? d.nominee.ts)) / DAY_MS),
	);
	try {
		kb.query(
			"INSERT INTO knowledge_proposals (ts, knowledge_id, kind, score, age_days, confidence, reason, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)",
		).run(
			now,
			d.nominee.id,
			`consolidate-${d.action}`,
			d.sim,
			ageDays,
			d.nominee.confidence,
			d.reason,
			d.payload,
		);
	} catch {
		return false;
	}
	noteAppend(
		kb,
		d.nominee.id,
		by,
		`consolidation proposal (${d.action}) vs k#${d.winner.id} — dispose pending (W1227)`,
	);
	return true;
}

// the proposal payload (knowledge_proposals.payload JSON)
export interface ConsolidationPayload {
	action: ConsolidationAction;
	nominee: { id: number; version: number };
	winner: { id: number; version: number };
	sim: number;
	mergedFact: string | null;
	carry: {
		winner: ConsolidationProvenance;
		loser: ConsolidationProvenance;
	};
}

export interface ConsolidationDisposeResult {
	ok: boolean;
	retired: boolean;
	stale: boolean;
}

// the dispose gate's consolidate arm — kind-dispatched from disposeProposal.
// approve executes the minted payload under CAS; dismiss flips proposal state
// only (the sweep's cooldown map reads it next pass). No row mutation is ever
// unreviewed: this runs ONLY from knowledge-dispose.
export function consolidateDisposeTx(
	kb: Database,
	gov: Database | null,
	proposalId: number,
	decision: "approve" | "dismiss",
	opts: { by?: string; note?: string } = {},
): ConsolidationDisposeResult {
	if (decision === "dismiss") {
		const up = kb
			.query(
				"UPDATE knowledge_proposals SET state = 'dismissed', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'",
			)
			.run(opts.by ?? "human", Date.now(), proposalId);
		return { ok: up.changes > 0, retired: false, stale: false };
	}
	return approveHead(kb, gov, proposalId, opts);
}

// approveHead: validate the minted payload, then hand to the CAS transaction
function approveHead(
	kb: Database,
	gov: Database | null,
	proposalId: number,
	opts: { by?: string; note?: string },
): ConsolidationDisposeResult {
	const head = kb
		.query(
			"SELECT payload FROM knowledge_proposals WHERE id = ? AND state = 'open'",
		)
		.get(proposalId) as { payload: string | null } | undefined;
	if (!head?.payload) return { ok: false, retired: false, stale: false };
	let payload: ConsolidationPayload;
	try {
		payload = JSON.parse(head.payload) as ConsolidationPayload;
	} catch {
		return { ok: false, retired: false, stale: false };
	}
	return approveConsolidation(kb, gov, proposalId, payload, opts);
}

// the row shape the CAS read needs
interface LiveRow {
	id: number;
	state: string;
	fact: string;
	version: number;
}

// casRead: re-read BOTH rows inside the open transaction and compare versions
// + liveness — the compare-and-set the mission's "CAS compare" names. Any
// movement since mint (content, state, provenance — every mutation bumps the
// row version) refuses as stale.
function casRead(
	kb: Database,
	payload: ConsolidationPayload,
):
	| { ok: true; winner: LiveRow; nominee: LiveRow }
	| { ok: false; why: string } {
	const read = (id: number): LiveRow | undefined =>
		kb
			.query(
				"SELECT id, state, fact, COALESCE(version, 1) AS version FROM knowledge WHERE id = ?",
			)
			.get(id) as LiveRow | undefined;
	const nominee = read(payload.nominee.id);
	const winner = read(payload.winner.id);
	if (!nominee || !winner) return { ok: false, why: "row missing" };
	if (nominee.state === "retired" || nominee.state === "graveyard")
		return {
			ok: false,
			why: `nominee k#${nominee.id} already ${nominee.state}`,
		};
	if (winner.state === "retired" || winner.state === "graveyard")
		return { ok: false, why: `winner k#${winner.id} already ${winner.state}` };
	if (nominee.version !== payload.nominee.version)
		return {
			ok: false,
			why: `nominee k#${nominee.id} moved (v${nominee.version} ≠ minted v${payload.nominee.version})`,
		};
	if (winner.version !== payload.winner.version)
		return {
			ok: false,
			why: `winner k#${winner.id} moved (v${winner.version} ≠ minted v${payload.winner.version})`,
		};
	return { ok: true, winner, nominee };
}

// approveConsolidation: ONE BEGIN IMMEDIATE over compare + apply — a racing
// writer either serializes before (CAS refuses, proposal closes 'stale') or
// after the commit (proposal already closed) — never interleaves.
function approveConsolidation(
	kb: Database,
	gov: Database | null,
	proposalId: number,
	payload: ConsolidationPayload,
	opts: { by?: string; note?: string },
): ConsolidationDisposeResult {
	const by = opts.by ?? "human";
	let result: ConsolidationDisposeResult;
	try {
		kb.run("BEGIN IMMEDIATE");
		const c = casRead(kb, payload);
		if (!c.ok) {
			kb.run("ROLLBACK");
			staleClose(kb, proposalId, by, c.why);
			return { ok: true, retired: false, stale: true };
		}
		result = applyAndCommit(kb, c.winner, c.nominee, payload, proposalId, by);
	} catch (e) {
		try {
			kb.run("ROLLBACK");
		} catch {}
		throw e;
	}
	if (result.retired) emitApproved(gov, by, payload, proposalId, opts.note);
	return result;
}

// applyAndCommit: the CAS-passed mutation — update (merge) or delete (retire)
// — plus the proposal flip, inside the open transaction.
function applyAndCommit(
	kb: Database,
	winner: LiveRow,
	nominee: LiveRow,
	payload: ConsolidationPayload,
	proposalId: number,
	by: string,
): ConsolidationDisposeResult {
	if (payload.action === "update")
		applyUpdate(kb, winner, nominee, payload, by);
	else applyRetire(kb, winner, nominee, by);
	kb.query(
		"UPDATE knowledge_proposals SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?",
	).run(by, Date.now(), proposalId);
	kb.run("COMMIT");
	return { ok: true, retired: true, stale: false };
}

// applyUpdate: THE provenance law — the SET clause lists only fact (+ version);
// source/source_ref/source_hash/origin_sid ride untouched, and the absorbed
// side's provenance lands in the winner's contributors ledger (append-only).
function applyUpdate(
	kb: Database,
	winner: LiveRow,
	nominee: LiveRow,
	payload: ConsolidationPayload,
	by: string,
): void {
	kb.query(
		"UPDATE knowledge SET fact = ?, version = COALESCE(version, 1) + 1 WHERE id = ?",
	).run(payload.mergedFact ?? winner.fact, winner.id);
	noteAppend(
		kb,
		winner.id,
		by,
		`consolidated k#${nominee.id} — provenance carried: source=${payload.carry.loser.source ?? "null"} source_ref=${payload.carry.loser.sourceRef ?? "null"} (W1227)`,
	);
	// the absorbed side retires too (superseded-by the winner) — the merge is
	// one closed fact, the loser exits search (reason text documents this)
	applyRetire(kb, winner, nominee, by);
}

// applyRetire: the delete band's action — the nominee retires append-only
// (graveyards never delete), superseded-by the winner, version bumped.
function applyRetire(
	kb: Database,
	winner: LiveRow,
	nominee: LiveRow,
	by: string,
): void {
	kb.query(
		"UPDATE knowledge SET state = 'retired', superseded_by = ?, version = COALESCE(version, 1) + 1 WHERE id = ? AND state NOT IN ('retired', 'graveyard')",
	).run(winner.id, nominee.id);
	noteAppend(
		kb,
		nominee.id,
		by,
		`retired by consolidation into k#${winner.id} (W1227)`,
	);
}

// staleClose: a CAS refusal closes the proposal 'stale' — an outdated
// proposal is noise; the sweep re-proposes fresh next pass.
function staleClose(
	kb: Database,
	proposalId: number,
	by: string,
	why: string,
): void {
	kb.query(
		"UPDATE knowledge_proposals SET state = 'stale', decided_by = ?, decided_at = ?, reason = reason || ? WHERE id = ? AND state = 'open'",
	).run(by, Date.now(), ` — stale: ${why}`, proposalId);
}

// emitApproved: one plane event per executed consolidation
function emitApproved(
	gov: Database | null,
	by: string,
	payload: ConsolidationPayload,
	proposalId: number,
	note?: string,
): void {
	emitConsolidate(gov, "knowledge.consolidated", by, {
		proposal: proposalId,
		action: payload.action,
		nominee: payload.nominee.id,
		winner: payload.winner.id,
		note: note ?? null,
	});
}
