// hooks/lib/consult-federation.ts — consult federation (W934.2.1.2): the
// durable consult envelope (trace_id + idempotency key), the routing ladder's
// hub edge (kb → facts → expert → entitled hub), and the stale-feedback loop
// that revokes knowledge rows when a plane-answered consult is marked failed.
// Contract: docs/design/consult-federation.md (W934.1). Config-over-code:
// the hub edge is operator-declared in
// ~/.claude/local-llm/consult-federation.json — absent config = hub leg
// disabled, never a hardcoded hub.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GovernorStore } from "./govdb.ts";

// ─── envelope identity ───
// W3C trace id: 32 lowercase hex chars, shared by every hop of one consult.
// The durable consult id stays the consults rowid (C<rowid>).
export function mintTraceId(): string {
	return randomUUID().replaceAll("-", "");
}

// Normalized question = lowercase token stream. Same token regex as
// coord/shared.ts's kbTerms (single-flight keys must equal kb-dedup keys),
// mirrored here so this lib stays free of shared.ts's module-load db open.
export function normQuestion(q: string): string {
	return q
		.toLowerCase()
		.split(/[^a-z0-9_.-]+/)
		.filter(Boolean)
		.join(" ");
}

export function idempotencyKey(
	question: string,
	scope: string | null,
	project: string,
): string {
	return createHash("sha256")
		.update(`${project}|${normQuestion(question)}|${scope ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}

export interface ConsultEnvelope {
	consultId: string; // durable C<rowid>
	traceId: string; // W3C trace id, shared by every hop
	idempotencyKey: string;
	origin: string; // asker sid
	project: string;
	scope: string | null;
	maxHops: number; // hub may forward once to its parent when policy permits
	visitedHubs: string[]; // loop prevention: labels already visited
}

// ─── classification ───
// A scoped consult is a local data-domain question: a scope is a local
// path, so its content never leaves the machine. Unscoped consults MAY
// escalate when policy permits. Fail-closed on purpose.
export function classifyQuestion(
	_question: string,
	scope: string | null,
): { privateDomain: boolean } {
	return { privateDomain: scope != null && scope.trim() !== "" };
}

// ─── hub policy (config-over-code) ───
export interface HubPolicy {
	enabled: true;
	hub?: string;
	maxHops?: number;
	deadlineMs?: number;
	cooldownMs?: number;
}

export const FEDERATION_CONFIG_PATH = (): string =>
	process.env.SUSPENDERS_CONSULT_FEDERATION_FILE ??
	`${process.env.HOME}/.claude/local-llm/consult-federation.json`;

// Absent/unparseable/disabled config = the hub leg never fires. The file is
// operator-owned (mode 600 class, like belt.env) — repos carry nothing.
export function hubPolicy(): HubPolicy | null {
	try {
		const raw = JSON.parse(
			readFileSync(FEDERATION_CONFIG_PATH(), "utf8"),
		) as HubPolicy;
		return raw?.enabled === true ? raw : null;
	} catch {
		return null;
	}
}

// ─── schema ───
export function ensureConsultFederation(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS consult_federation (
	 consult_id INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
	 route TEXT NOT NULL DEFAULT '[]', hub TEXT, state TEXT NOT NULL DEFAULT 'OPEN',
	 created_at INTEGER NOT NULL)`);
	db.run(
		"CREATE INDEX IF NOT EXISTS consult_federation_key ON consult_federation(idempotency_key, created_at)",
	);
	db.run(`CREATE TABLE IF NOT EXISTS consult_citations (
	 consult_id INTEGER NOT NULL, kind TEXT NOT NULL, ref_id INTEGER NOT NULL,
	 source_ref TEXT, source_hash TEXT, created_at INTEGER NOT NULL)`);
	db.run(
		"CREATE INDEX IF NOT EXISTS consult_citations_c ON consult_citations(consult_id)",
	);
	db.run(`CREATE TABLE IF NOT EXISTS consult_hub_cache (
	 key TEXT PRIMARY KEY, outcome TEXT NOT NULL, hub TEXT, until INTEGER NOT NULL)`);
}

// ─── citations (knowledge IDs) ───
// Every plane/hub-answered consult records WHICH knowledge it answered from:
// kind kb → consult_kb.id, kind fact → knowledge.id, kind hub → the remote
// hub's own row id (source_ref/hash travel verbatim from the hub).
export type CiteKind = "kb" | "fact" | "hub";

export interface Citation {
	kind: CiteKind;
	refId: number;
	sourceRef: string | null;
	sourceHash: string | null;
}

export function recordCitations(
	db: GovernorStore,
	consultId: number,
	cites: Citation[],
): void {
	ensureConsultFederation(db);
	for (const c of cites)
		db.query(
			"INSERT INTO consult_citations (consult_id, kind, ref_id, source_ref, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(consultId, c.kind, c.refId, c.sourceRef, c.sourceHash, Date.now());
}

export function citationsFor(db: GovernorStore, consultId: number): Citation[] {
	ensureConsultFederation(db);
	const raw = db
		.query(
			"SELECT kind, ref_id, source_ref, source_hash FROM consult_citations WHERE consult_id = ? ORDER BY rowid",
		)
		.all(consultId) as {
		kind: string;
		ref_id: number;
		source_ref: string | null;
		source_hash: string | null;
	}[];
	return raw.map((r) => ({
		kind: r.kind as CiteKind,
		refId: r.ref_id,
		sourceRef: r.source_ref,
		sourceHash: r.source_hash,
	}));
}

// ─── route record ───
export type RouteStageName =
	| "kb"
	| "fact"
	| "expert"
	| "hub"
	| "refused"
	| "degraded";

export interface RouteStage {
	stage: RouteStageName;
	at: number;
	detail?: string;
}

export function recordRouteStage(
	db: GovernorStore,
	consultId: number,
	stage: RouteStageName,
	detail?: string,
): void {
	ensureConsultFederation(db);
	const row = db
		.query("SELECT route FROM consult_federation WHERE consult_id = ?")
		.get(consultId) as { route: string } | undefined;
	if (!row) return; // no envelope row yet — the CLI writes it right after INSERT
	const stages = JSON.parse(row.route) as RouteStage[];
	stages.push({
		stage,
		at: Date.now(),
		...(detail ? { detail: detail.slice(0, 200) } : {}),
	});
	db.query("UPDATE consult_federation SET route = ? WHERE consult_id = ?").run(
		JSON.stringify(stages),
		consultId,
	);
}

// ─── hub edge (send side) ───
export interface HubAnswer {
	ok: boolean;
	state: "ANSWERED" | "PENDING" | "DEGRADED";
	answer: string | null;
	citations: Citation[];
	hub: string | null;
	via: string | null;
	why: string | null;
}
