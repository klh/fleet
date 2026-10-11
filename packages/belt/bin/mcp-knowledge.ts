// mcp-knowledge.ts — W260: read-only knowledge-store retrieval for the belt
// MCP server. Queries the fleet knowledge layer's live topology directly:
//   knowledge.db : knowledge + knowledge_fts (the prose-card store)
//   governor.db  : facts + facts_fts, consult_kb + consult_kb_fts
// Both open READ-ONLY — this module never writes the knowledge layer (the
// write face is coord/knowledge-worker, per the one-ledger law). Self-contained
// in belt so the runtime home (~/.claude/local-llm) needs no suspenders
// imports; belt/install.sh only ships bin/*. Paths are env-overridable for
// tests: BELT_KNOWLEDGE_DB / BELT_GOVERNOR_DB.
import { Database } from "bun:sqlite";

export interface KnowledgeFilters {
	limit?: number;
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
}

export interface KnowledgeCard {
	kind: "knowledge" | "fact" | "consult_kb";
	id: number | string;
	topic?: string;
	text: string;
	snippet: string;
	state?: string | null;
	originKind?: string | null;
	domain?: string | null;
	area?: string | null;
	sourceRef?: string | null;
	ageDays?: number;
	confidence?: number | null;
}

const KNOWLEDGE_DB = () =>
	process.env.BELT_KNOWLEDGE_DB ??
	`${process.env.HOME}/.cache/claude-governor/knowledge.db`;
const GOVERNOR_DB = () =>
	process.env.BELT_GOVERNOR_DB ??
	`${process.env.HOME}/.cache/claude-governor/governor.db`;

// FTS5 MATCH terms: quoted, OR-joined — bm25 ranks the union so a rephrasing
// still surfaces ranked low; strict AND would hide it. Same shape as the
// suspenders search (one implementation there, a faithful port here — the two
// packages are runtime-decoupled by install).
export function ftsTerms(q: string): string {
	const terms = [
		...new Set(
			q
				.toLowerCase()
				.split(/[^a-z0-9_.-]+/)
				.filter((t) => t.length > 1),
		),
	];
	if (!terms.length) return "";
	return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

const openReadOnly = (path: string): Database | null => {
	try {
		const db = new Database(path, { readonly: true });
		db.run("PRAGMA busy_timeout=2000");
		return db;
	} catch {
		return null; // missing/unopenable store → that leg is honestly empty
	}
};

const ageDays = (ms: number | null | undefined): number =>
	Math.max(0, Math.round((Date.now() - (ms ?? 0)) / 86400000));

// knowledge cards — the primary store. Retired rows exit search; scoped
// filters are axis predicates on the FTS columns.
function searchKnowledgeCards(
	db: Database,
	match: string,
	f: KnowledgeFilters,
	limit: number,
): KnowledgeCard[] {
	const rows = db
		.query(
			`SELECT k.id, k.topic, k.fact, k.state, k.origin_kind, k.domain, k.area,
	k.source_ref, k.confidence, k.updated_at, k.ts,
	snippet(knowledge_fts, 1, '[', ']', '…', 12) AS snip
FROM knowledge_fts
JOIN knowledge k ON k.id = knowledge_fts.rowid
WHERE knowledge_fts MATCH ?
	AND k.state != 'retired'
	AND (? IS NULL OR k.domain = ?)
	AND (? IS NULL OR k.area = ?)
	AND (? IS NULL OR k.origin_kind = ?)
	AND (? IS NULL OR k.origin_system = ?)
ORDER BY rank + (${Date.now()} - COALESCE(k.updated_at, k.ts)) / 86400000.0 * 0.05
LIMIT ?`,
		)
		.all(
			match,
			f.domain ?? null,
			f.domain ?? null,
			f.area ?? null,
			f.area ?? null,
			f.originKind ?? null,
			f.originKind ?? null,
			f.originSystem ?? null,
			f.originSystem ?? null,
			limit,
		) as Record<string, unknown>[];
	return rows.map((r) => ({
		kind: "knowledge" as const,
		id: r.id as number,
		topic: r.topic as string,
		text: r.fact as string,
		snippet: (r.snip as string) ?? "",
		state: r.state as string,
		originKind: r.origin_kind as string | null,
		domain: r.domain as string | null,
		area: r.area as string | null,
		sourceRef: r.source_ref as string | null,
		confidence: r.confidence as number | null,
		ageDays: ageDays((r.updated_at ?? r.ts) as number),
	}));
}

// facts (key→value intel, e.g. lesson.*/finding.*) — no scope columns, so any
// scoped search honestly excludes them (a scope filter must never surface
// untaggable private intel).
function searchFacts(
	db: Database,
	match: string,
	f: KnowledgeFilters,
	limit: number,
): KnowledgeCard[] {
	if (f.domain || f.area || f.originKind || f.originSystem) return [];
	const rows = db
		.query(
			`SELECT f.key, f.value, f.ts,
	snippet(facts_fts, 0, '[', ']', '…', 12) AS snip
FROM facts_fts
JOIN facts f ON f.rowid = facts_fts.rowid
WHERE facts_fts MATCH ?
ORDER BY rank
LIMIT ?`,
		)
		.all(match, limit) as Record<string, unknown>[];
	return rows.map((r) => ({
		kind: "fact" as const,
		id: r.key as string,
		text: r.value as string,
		snippet: (r.snip as string) ?? "",
		ageDays: ageDays(r.ts as number),
	}));
}

// consult_kb — distilled ask/answer pairs. project tags the scope; area/kind/
// system filters honestly exclude the store (it carries none of those).
function searchConsultKb(
	db: Database,
	match: string,
	f: KnowledgeFilters,
	limit: number,
): KnowledgeCard[] {
	if (f.area || f.originKind || f.originSystem) return [];
	const rows = db
		.query(
			`SELECT c.id, c.problem, c.solution, c.project, c.created_at,
	snippet(consult_kb_fts, 0, '[', ']', '…', 12) AS snip
FROM consult_kb_fts
JOIN consult_kb c ON c.id = consult_kb_fts.rowid
WHERE consult_kb_fts MATCH ?
	AND (? IS NULL OR c.project = ?)
ORDER BY rank
LIMIT ?`,
		)
		.all(match, f.domain ?? null, f.domain ?? null, limit) as Record<
		string,
		unknown
	>[];
	return rows.map((r) => ({
		kind: "consult_kb" as const,
		id: r.id as number,
		topic: r.problem as string,
		text: r.solution as string,
		snippet: (r.snip as string) ?? "",
		domain: r.project as string | null,
		ageDays: ageDays(r.created_at as number),
	}));
}

// Ranked merge: ranks are NOT comparable across stores, so the array keeps the
// stores grouped — knowledge, then facts, then consult_kb (same contract as
// the suspenders search).
export function searchKnowledge(
	query: string,
	filters: KnowledgeFilters = {},
): KnowledgeCard[] {
	const match = ftsTerms(query);
	if (!match) return [];
	const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? 10)), 50);
	const out: KnowledgeCard[] = [];
	const kb = openReadOnly(KNOWLEDGE_DB());
	if (kb) {
		try {
			out.push(...searchKnowledgeCards(kb, match, filters, limit));
		} catch {} // pre-FTS store → skip honestly
		kb.close();
	}
	const gov = openReadOnly(GOVERNOR_DB());
	if (gov) {
		try {
			out.push(...searchFacts(gov, match, filters, limit));
		} catch {}
		try {
			out.push(...searchConsultKb(gov, match, filters, limit));
		} catch {}
		gov.close();
	}
	return out;
}
