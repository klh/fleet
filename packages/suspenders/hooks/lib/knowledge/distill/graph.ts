// distill/graph.ts — the knowledge graph: a property graph inside
// knowledge.db (no new database service). Nodes are knowledge entries
// (referencing their knowledge row — content is never duplicated) and
// extracted entities; edges are typed, weighted, attributed and stateful.
// Traversal is recursive CTEs with bounded depth and row caps. An embedded
// graph engine (e.g. Kuzu) is a later option ONLY if CTE traversal measures
// too slow — the k=2 benchmark lives in the distill e2e suite.
import type { Database } from "bun:sqlite";

export const NODE_KINDS = [
	"entry",
	"code",
	"package",
	"service",
	"config_key",
	"work_item",
	"commit",
	"incident",
	"model",
	"machine",
	"session",
	"project",
	"tool",
	"command",
	"script",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
	"about",
	"mentions",
	"related",
	"duplicate_of",
	"supersedes",
	"contradicts",
	"derived_from",
	"fixes",
	"caused_by",
	"applies_to",
	"observed_on",
	// decant source edges (session → file / tool, file ↔ file, command → script)
	"touched",
	"edited",
	"uses",
	"co_changed",
	"part_of",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export type EdgeState = "candidate" | "active" | "rejected";

export interface NodeInput {
	kind: NodeKind;
	key: string;
	label?: string;
	props?: Record<string, unknown>;
	hash?: string | null;
	ref?: string | null;
	state?: string;
}

export interface NodeRow {
	id: number;
	kind: NodeKind;
	key: string;
	label: string;
	props: string;
	hash: string | null;
	ref: string | null;
	usage: number;
	state: string;
	first_seen: number;
	last_seen: number;
	edge_at: number;
}

export interface EdgeInput {
	src: number;
	dst: number;
	type: EdgeType;
	weight?: number;
	evidenceRef?: string | null;
	createdBy: string;
	confidence?: number | null;
	state?: EdgeState;
}

/** active and human-rejected decisions outrank machine candidates; a
 *  rejected edge is never revived by a machine re-observation. */
const STATE_RANK: Record<string, number> = {
	candidate: 1,
	active: 2,
	rejected: 3,
};
export const stateRank = (s: string): number => STATE_RANK[s] ?? 0;

export function upsertNode(
	db: Database,
	n: NodeInput,
	now: number = Date.now(),
): number {
	const row = db
		.query(
			"INSERT INTO kg_nodes (kind, key, label, props, hash, ref, state, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET label = CASE WHEN excluded.label != '' THEN excluded.label ELSE kg_nodes.label END, props = CASE WHEN excluded.props != '{}' THEN excluded.props ELSE kg_nodes.props END, hash = COALESCE(excluded.hash, kg_nodes.hash), ref = COALESCE(excluded.ref, kg_nodes.ref), state = excluded.state, last_seen = excluded.last_seen RETURNING id",
		)
		.get(
			n.kind,
			n.key,
			(n.label ?? "").slice(0, 200),
			JSON.stringify(n.props ?? {}),
			n.hash ?? null,
			n.ref ?? null,
			n.state ?? "active",
			now,
			now,
		) as { id: number };
	return row.id;
}

export const nodeById = (db: Database, id: number): NodeRow | null =>
	(db.query("SELECT * FROM kg_nodes WHERE id = ?").get(id) as NodeRow | null) ??
	null;

export const nodeByKey = (
	db: Database,
	kind: NodeKind,
	key: string,
): NodeRow | null =>
	(db
		.query("SELECT * FROM kg_nodes WHERE kind = ? AND key = ?")
		.get(kind, key) as NodeRow | null) ?? null;

/** Write one edge. A re-observation refreshes weight/evidence/at only when
 *  its state ranks at least the stored state — machines never overwrite a
 *  human decision. Both endpoints get edge_at stamped (the scheduler's
 *  neighbours-changed boost). Returns true when a row was written. */
export function upsertEdge(
	db: Database,
	e: EdgeInput,
	now: number = Date.now(),
): boolean {
	if (e.src === e.dst) return false;
	const state = e.state ?? "candidate";
	const prior = db
		.query("SELECT state FROM kg_edges WHERE src = ? AND dst = ? AND type = ?")
		.get(e.src, e.dst, e.type) as { state: string } | null;
	if (prior && stateRank(prior.state) > stateRank(state)) return false;
	db.query(
		"INSERT INTO kg_edges (src, dst, type, weight, evidence_ref, created_by, confidence, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (src, dst, type) DO UPDATE SET weight = excluded.weight, evidence_ref = COALESCE(excluded.evidence_ref, kg_edges.evidence_ref), created_by = excluded.created_by, confidence = excluded.confidence, state = excluded.state, at = excluded.at",
	).run(
		e.src,
		e.dst,
		e.type,
		e.weight ?? 1,
		e.evidenceRef ?? null,
		e.createdBy,
		e.confidence ?? null,
		state,
		now,
	);
	db.query("UPDATE kg_nodes SET edge_at = ? WHERE id IN (?, ?)").run(
		now,
		e.src,
		e.dst,
	);
	return true;
}

export interface Neighbour {
	id: number;
	kind: string;
	key: string;
	label: string;
	depth: number;
}

/** k-hop neighbourhood (undirected), bounded by depth and a row cap; the
 *  two recursive arms each ride one edge index (src,type) / (dst,type). */
export function neighbours(
	db: Database,
	id: number,
	opts: { depth?: number; limit?: number; types?: EdgeType[] } = {},
): Neighbour[] {
	const depth = Math.max(1, Math.min(opts.depth ?? 2, 4));
	const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
	const types = opts.types?.length ? opts.types : null;
	const typeFilter = types
		? `AND e.type IN (${types.map(() => "?").join(",")})`
		: "";
	const tp = types ?? [];
	return db
		.query(
			`WITH RECURSIVE walk(node, depth) AS (
				SELECT ?, 0
				UNION
				SELECT e.dst, w.depth + 1 FROM walk w JOIN kg_edges e ON e.src = w.node
					WHERE w.depth < ? AND e.state != 'rejected' ${typeFilter}
				UNION
				SELECT e.src, w.depth + 1 FROM walk w JOIN kg_edges e ON e.dst = w.node
					WHERE w.depth < ? AND e.state != 'rejected' ${typeFilter}
				LIMIT ?
			)
			SELECT n.id, n.kind, n.key, n.label, MIN(w.depth) AS depth
			FROM walk w JOIN kg_nodes n ON n.id = w.node
			WHERE w.node != ? GROUP BY n.id ORDER BY depth, n.id LIMIT ?`,
		)
		.all(id, depth, ...tp, depth, ...tp, limit * 8, id, limit) as Neighbour[];
}

/** Shortest undirected path a → b within maxDepth hops (node ids), or null. */
export function graphPath(
	db: Database,
	a: number,
	b: number,
	maxDepth = 4,
): number[] | null {
	if (a === b) return [a];
	const depth = Math.max(1, Math.min(maxDepth, 6));
	const row = db
		.query(
			`WITH RECURSIVE walk(node, depth, trail) AS (
				SELECT ?, 0, ',' || ? || ','
				UNION ALL
				SELECT e.dst, w.depth + 1, w.trail || e.dst || ',' FROM walk w
					JOIN kg_edges e ON e.src = w.node
					WHERE w.depth < ? AND e.state != 'rejected'
						AND instr(w.trail, ',' || e.dst || ',') = 0
				UNION ALL
				SELECT e.src, w.depth + 1, w.trail || e.src || ',' FROM walk w
					JOIN kg_edges e ON e.dst = w.node
					WHERE w.depth < ? AND e.state != 'rejected'
						AND instr(w.trail, ',' || e.src || ',') = 0
				LIMIT 50000
			)
			SELECT trail FROM walk WHERE node = ? ORDER BY depth LIMIT 1`,
		)
		.get(a, a, depth, depth, b) as {
		trail: string;
	} | null;
	if (!row) return null;
	return row.trail
		.split(",")
		.filter(Boolean)
		.map((s) => Number(s));
}

export interface AboutHit {
	nodeId: number;
	knowledgeId: number | null;
	label: string;
	edge: string;
	state: string;
	stale: boolean;
	updatedAt: number;
}

/** Resolve a free-form target (repo path, label, W-id, port, key) to nodes. */
export function resolveTarget(db: Database, target: string): NodeRow[] {
	const t = target.trim();
	if (!t) return [];
	return db
		.query(
			"SELECT * FROM kg_nodes WHERE kind != 'entry' AND (key = ? OR label = ? OR key LIKE '%' || ?) ORDER BY CASE WHEN key = ? THEN 0 ELSE 1 END, id LIMIT 20",
		)
		.all(t, t, `/${t.replace(/^\/+/, "")}`, t) as NodeRow[];
}

/** Entries touching a target (about / applies_to / mentions), ranked by
 *  trust (active > candidate, fresh > stale) then recency. Reads the
 *  knowledge row for state + staleness — the graph holds references only. */
export function aboutTarget(
	db: Database,
	target: string,
	limit = 20,
): AboutHit[] {
	const ids = resolveTarget(db, target).map((n) => n.id);
	if (!ids.length) return [];
	const ph = ids.map(() => "?").join(",");
	const hasKnowledge = !!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge'",
		)
		.get();
	const join = hasKnowledge
		? "LEFT JOIN knowledge k ON 'knowledge:' || k.id = n.ref"
		: "";
	const cols = hasKnowledge
		? "k.id AS kid, COALESCE(k.state, n.state) AS kstate, k.stale_at AS stale_at, COALESCE(k.updated_at, n.last_seen) AS upd"
		: "NULL AS kid, n.state AS kstate, NULL AS stale_at, n.last_seen AS upd";
	const rows = db
		.query(
			`SELECT n.id AS nid, n.label AS label, e.type AS etype, ${cols}
			FROM kg_edges e JOIN kg_nodes n ON n.id = e.src ${join}
			WHERE e.dst IN (${ph}) AND n.kind = 'entry' AND e.state != 'rejected'
				AND e.type IN ('about', 'applies_to', 'mentions')`,
		)
		.all(...ids) as {
		nid: number;
		label: string;
		etype: string;
		kid: number | null;
		kstate: string;
		stale_at: number | null;
		upd: number;
	}[];
	const trust = (r: (typeof rows)[number]): number =>
		(r.kstate === "active" ? 4 : r.kstate === "candidate" ? 2 : 0) +
		(r.stale_at ? 0 : 1) +
		(r.etype === "mentions" ? 0 : 1);
	const seen = new Set<number>();
	return rows
		.filter((r) => !["retired", "graveyard"].includes(r.kstate))
		.sort((x, y) => trust(y) - trust(x) || y.upd - x.upd)
		.filter((r) => !seen.has(r.nid) && seen.add(r.nid))
		.slice(0, limit)
		.map((r) => ({
			nodeId: r.nid,
			knowledgeId: r.kid,
			label: r.label,
			edge: r.etype,
			state: r.kstate,
			stale: r.stale_at !== null,
			updatedAt: r.upd,
		}));
}

/** Recall expansion seam: knowledge row ids whose entries are about / apply
 *  to any of the given paths — so a lane editing a file gets its lessons.
 *  Search surfaces union these ids into their hits. */
export function recallByPaths(
	db: Database,
	paths: string[],
	limit = 10,
): number[] {
	const out: number[] = [];
	for (const p of paths)
		for (const h of aboutTarget(db, p, limit))
			if (h.knowledgeId !== null && !out.includes(h.knowledgeId))
				out.push(h.knowledgeId);
	return out.slice(0, limit);
}

/** Count a recall against the entry nodes — the scheduler's usage boost. */
export function recordRecall(db: Database, knowledgeIds: number[]): void {
	const q = db.query("UPDATE kg_nodes SET usage = usage + 1 WHERE ref = ?");
	for (const id of knowledgeIds) q.run(`knowledge:${id}`);
}

export interface ContradictionRow {
	a: number;
	b: number;
	aLabel: string;
	bLabel: string;
	state: string;
	evidence: string | null;
}

export const contradictions = (db: Database, limit = 50): ContradictionRow[] =>
	db
		.query(
			"SELECT e.src AS a, e.dst AS b, s.label AS aLabel, d.label AS bLabel, e.state AS state, e.evidence_ref AS evidence FROM kg_edges e JOIN kg_nodes s ON s.id = e.src JOIN kg_nodes d ON d.id = e.dst WHERE e.type = 'contradicts' AND e.state != 'rejected' ORDER BY e.at DESC LIMIT ?",
		)
		.all(limit) as ContradictionRow[];

/** Resolve an entry argument: `knowledge:<id>`, a bare knowledge id, a node
 *  id prefixed `#`, or any node key. */
export function resolveEntry(db: Database, arg: string): NodeRow | null {
	const a = arg.trim();
	if (a.startsWith("#")) return nodeById(db, Number(a.slice(1)));
	if (/^\d+$/.test(a)) return nodeByKey(db, "entry", `knowledge:${a}`);
	return (
		nodeByKey(db, "entry", a) ??
		((db
			.query("SELECT * FROM kg_nodes WHERE key = ? ORDER BY id LIMIT 1")
			.get(a) as NodeRow | null) ||
			null)
	);
}
