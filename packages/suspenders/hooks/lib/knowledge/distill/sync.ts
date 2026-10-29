// distill/sync.ts — the graph's hub-replication seam. Nodes and edges cross
// as KEYED rows (kind+key, never local integer ids); edge conflicts resolve
// by state precedence (rejected/active outrank candidate — a human decision
// is never overwritten by a machine re-observation), then last-writer by
// `at`. Entry nodes cross under their CONTENT key (`content:<hash>`) because
// knowledge row ids are machine-local; the importer binds them to a local
// entry with the same content hash when one exists.
//
// SECURITY: decant-derived rows replicate only when scrubbed AND in a live
// state; raw transcript text never exists in the graph to begin with.
// The transport (which hub, when) rides fork A's knowledge-sync once its
// graph leg lands — until then exportGraphDelta / importGraphDelta are the
// tested contract.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	EDGE_TYPES,
	type EdgeType,
	NODE_KINDS,
	type NodeKind,
	stateRank,
	upsertNode,
} from "./graph.ts";

const NodeKeySchema = z
	.object({ kind: z.enum(NODE_KINDS), key: z.string().min(1) })
	.strict();

export const GraphDeltaSchema = z
	.object({
		nodes: z.array(
			NodeKeySchema.extend({
				label: z.string(),
				props: z.record(z.string(), z.unknown()),
				hash: z.string().nullable(),
				state: z.string(),
				last_seen: z.number(),
			}).strict(),
		),
		edges: z.array(
			z
				.object({
					src: NodeKeySchema,
					dst: NodeKeySchema,
					type: z.enum(EDGE_TYPES),
					weight: z.number(),
					state: z.enum(["candidate", "active", "rejected"]),
					confidence: z.number().nullable(),
					created_by: z.string(),
					evidence_ref: z.string().nullable(),
					at: z.number(),
				})
				.strict(),
		),
	})
	.strict();
export type GraphDelta = z.infer<typeof GraphDeltaSchema>;

interface RawNode {
	id: number;
	kind: NodeKind;
	key: string;
	label: string;
	props: string;
	hash: string | null;
	state: string;
	last_seen: number;
}

const exportable = (n: RawNode): boolean => {
	const p = JSON.parse(n.props) as { origin?: string; scrubbed?: boolean };
	if (n.kind === "entry" && !n.hash) return false;
	if (p.origin !== "decant") return true;
	return p.scrubbed === true && n.state === "active";
};

const wireKey = (n: RawNode): { kind: NodeKind; key: string } =>
	n.kind === "entry"
		? { kind: n.kind, key: `content:${n.hash ?? ""}` }
		: { kind: n.kind, key: n.key };

/** Everything changed at/after `since` that may leave this machine. */
export function exportGraphDelta(db: Database, since: number): GraphDelta {
	const nodes = (
		db
			.query(
				"SELECT id, kind, key, label, props, hash, state, last_seen FROM kg_nodes",
			)
			.all() as RawNode[]
	).filter(exportable);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const edges = db
		.query(
			"SELECT src, dst, type, weight, state, confidence, created_by, evidence_ref, at FROM kg_edges WHERE at >= ?",
		)
		.all(since) as {
		src: number;
		dst: number;
		type: EdgeType;
		weight: number;
		state: "candidate" | "active" | "rejected";
		confidence: number | null;
		created_by: string;
		evidence_ref: string | null;
		at: number;
	}[];
	return {
		nodes: nodes
			.filter((n) => n.last_seen >= since)
			.map((n) => ({
				...wireKey(n),
				label: n.label,
				props: JSON.parse(n.props) as Record<string, unknown>,
				hash: n.hash,
				state: n.state,
				last_seen: n.last_seen,
			})),
		edges: edges.flatMap((e) => {
			const s = byId.get(e.src);
			const d = byId.get(e.dst);
			if (!s || !d) return [];
			if (e.created_by === "decant" && e.state === "rejected") return [];
			return [{ ...e, src: wireKey(s), dst: wireKey(d) }];
		}),
	};
}

function localId(
	db: Database,
	k: { kind: NodeKind; key: string },
): number | null {
	if (k.kind === "entry" && k.key.startsWith("content:")) {
		const hit = db
			.query(
				"SELECT id FROM kg_nodes WHERE kind = 'entry' AND hash = ? ORDER BY id LIMIT 1",
			)
			.get(k.key.slice(8)) as { id: number } | null;
		if (hit) return hit.id;
	}
	return (
		(
			db
				.query("SELECT id FROM kg_nodes WHERE kind = ? AND key = ?")
				.get(k.kind, k.key) as {
				id: number;
			} | null
		)?.id ?? null
	);
}

/** Apply a peer's delta. Returns rows applied (nodes + edges). */
export function importGraphDelta(db: Database, raw: unknown): number {
	const delta = GraphDeltaSchema.parse(raw);
	let applied = 0;
	db.transaction(() => {
		for (const n of delta.nodes) {
			const id = localId(db, n);
			const cur =
				id === null
					? null
					: (db
							.query("SELECT last_seen FROM kg_nodes WHERE id = ?")
							.get(id) as { last_seen: number });
			if (cur && cur.last_seen >= n.last_seen) continue;
			if (id !== null) {
				db.query(
					"UPDATE kg_nodes SET label = ?, props = ?, state = ?, last_seen = ? WHERE id = ?",
				).run(n.label, JSON.stringify(n.props), n.state, n.last_seen, id);
			} else
				upsertNode(
					db,
					{
						kind: n.kind,
						key: n.key,
						label: n.label,
						props: n.props,
						hash: n.hash,
						state: n.state,
					},
					n.last_seen,
				);
			applied++;
		}
		for (const e of delta.edges) {
			const src = localId(db, e.src);
			const dst = localId(db, e.dst);
			if (src === null || dst === null) continue;
			const cur = db
				.query(
					"SELECT state, at FROM kg_edges WHERE src = ? AND dst = ? AND type = ?",
				)
				.get(src, dst, e.type) as { state: string; at: number } | null;
			if (cur) {
				const r = stateRank(e.state) - stateRank(cur.state);
				if (r < 0 || (r === 0 && cur.at >= e.at)) continue;
			}
			db.query(
				"INSERT INTO kg_edges (src, dst, type, weight, evidence_ref, created_by, confidence, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (src, dst, type) DO UPDATE SET weight = excluded.weight, evidence_ref = excluded.evidence_ref, created_by = excluded.created_by, confidence = excluded.confidence, state = excluded.state, at = excluded.at",
			).run(
				src,
				dst,
				e.type,
				e.weight,
				e.evidence_ref,
				e.created_by,
				e.confidence,
				e.state,
				e.at,
			);
			applied++;
		}
	})();
	return applied;
}
