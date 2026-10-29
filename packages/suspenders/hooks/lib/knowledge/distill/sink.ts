// distill/sink.ts — the distiller's seams into the knowledge store:
//   - the entry index (knowledge rows → `entry` nodes, incremental by
//     updated_at; the graph references rows, never copies their text),
//   - candidate writes (store.upsert → state `candidate`; promotion stays a
//     human act — fork A's promote gate), with structured provenance,
//   - proposals on the human dispose surface (knowledge_proposals) — merges
//     and contradictions are PROPOSED, never applied,
//   - the scrub every decant-derived string passes before it is stored.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	redactMatches,
	type ScrubRule,
	scrubRules,
} from "../../gates/scrub.ts";
import type { CurationInput, KevCuration } from "../kev-curation.ts";
import { redactSecrets } from "../knowledge.ts";
import type { KnowledgeUpsert } from "../store-schema.ts";
import { upsertNode } from "./graph.ts";
import { getState, setState } from "./schema.ts";

export const sha = (s: string): string =>
	createHash("sha256").update(s).digest("hex");

export interface KnowledgeRow {
	id: number;
	topic: string;
	fact: string;
	state: string;
	confidence: number;
	origin_kind: string | null;
	origin_system: string | null;
	origin_sid: string | null;
	source_ref: string | null;
	source_hash: string | null;
	stale_at: number | null;
	stale_reason: string | null;
	updated_at: number | null;
}

export const knowledgeRow = (db: Database, id: number): KnowledgeRow | null =>
	(db
		.query(
			"SELECT id, topic, fact, state, confidence, origin_kind, origin_system, origin_sid, source_ref, source_hash, stale_at, stale_reason, updated_at FROM knowledge WHERE id = ?",
		)
		.get(id) as KnowledgeRow | null) ?? null;

export const knowledgeIdOf = (ref: string | null): number | null => {
	const m = ref ? /^knowledge:(\d+)$/.exec(ref) : null;
	return m?.[1] ? Number(m[1]) : null;
};

const LIVE = new Set(["active", "candidate"]);

/** Mirror changed knowledge rows into entry nodes. Returns rows indexed. */
export function syncEntries(db: Database, now: number = Date.now()): number {
	const cursor = Number(getState(db, "entries.updated_at") ?? 0);
	const rows = db
		.query(
			"SELECT id, topic, fact, state, origin_kind, source_ref, source_hash, COALESCE(updated_at, ts) AS u FROM knowledge WHERE COALESCE(updated_at, ts) >= ? ORDER BY u, id LIMIT 5000",
		)
		.all(cursor) as (Pick<
		KnowledgeRow,
		| "id"
		| "topic"
		| "fact"
		| "state"
		| "origin_kind"
		| "source_ref"
		| "source_hash"
	> & { u: number })[];
	let high = cursor;
	db.transaction(() => {
		for (const r of rows) {
			upsertNode(
				db,
				{
					kind: "entry",
					key: `knowledge:${String(r.id)}`,
					label: r.topic,
					ref: `knowledge:${String(r.id)}`,
					hash: sha(`${r.topic}\0${r.fact}\0${r.source_hash ?? ""}`),
					props: { kstate: r.state, origin_kind: r.origin_kind },
					state: LIVE.has(r.state) ? "active" : "retired",
				},
				now,
			);
			high = Math.max(high, r.u);
		}
		setState(db, "entries.updated_at", String(high));
	})();
	return rows.length;
}

export interface CandidateDraft {
	topic: string;
	fact: string;
	confidence: number;
	originKind: string;
	originSystem?: string | null;
	sourceRef: string | null;
	sourceHash?: string | null;
	originSid?: string | null;
	/** structured provenance: every member / evidence reference */
	provenance: { source_refs: string[]; by: string; model?: string };
}

export interface ProposalDraft {
	knowledgeId: number;
	kind: "distill-dedupe" | "distill-contradiction";
	score: number;
	reason: string;
	payload: Record<string, unknown>;
}

export interface DistillSink {
	/** store a candidate (never active); returns the knowledge row id */
	upsertCandidate(d: CandidateDraft): Promise<number>;
	/** open one proposal; false when one is already open for the row */
	propose(p: ProposalDraft): boolean;
	/** Kev's store/noise/review verdict (unavailable = defer) */
	kev(input: CurationInput): Promise<KevCuration>;
}

/** The production sink over one knowledge.db handle. */
export function storeSink(
	db: Database,
	store: { upsert(row: KnowledgeUpsert): Promise<number> },
	kev: (input: CurationInput) => Promise<KevCuration>,
): DistillSink {
	return {
		async upsertCandidate(d) {
			const id = await store.upsert({
				topic: d.topic.slice(0, 80),
				fact: d.fact.slice(0, 400),
				confidence: d.confidence,
				domain: null,
				area: null,
				originKind: d.originKind,
				originSystem: d.originSystem ?? null,
				sourceRef: d.sourceRef,
				sourceHash: d.sourceHash ?? null,
				originSid: d.originSid ?? null,
				supersedesId: null,
			});
			db.query("UPDATE knowledge SET provenance = ? WHERE id = ?").run(
				JSON.stringify(d.provenance),
				id,
			);
			return id;
		},
		propose(p) {
			return (
				db
					.query(
						"INSERT OR IGNORE INTO knowledge_proposals (ts, knowledge_id, kind, score, age_days, confidence, reason, state, payload) VALUES (?, ?, ?, ?, 0, ?, ?, 'open', ?)",
					)
					.run(
						Date.now(),
						p.knowledgeId,
						p.kind,
						p.score,
						p.score,
						p.reason.slice(0, 500),
						JSON.stringify(p.payload),
					).changes > 0
			);
		},
		kev,
	};
}

let rulesCache: ScrubRule[] | null = null;

/** Scrub rule set (home paths, denylist hosts, key material) + the
 *  knowledge layer's secret redaction — applied to every decant-derived
 *  string before it lands in the graph or the store. */
export function scrubbed(text: string): string {
	rulesCache ??= scrubRules();
	return redactSecrets(redactMatches(text, rulesCache)).text;
}
