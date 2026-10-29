// distill/sync.ts — the graph's replication core (the wire + both ends).
// Nodes and edges cross as KEYED rows (kind+key, never local integer ids);
// conflicts resolve by state precedence then last-writer (`last_seen` for
// nodes, `at` for edges) — edges ride the graph's own stateRank (a human
// rejection is terminal, never revived by a machine row), nodes ride the
// sync rank active > candidate > rejected. Entry nodes cross
// under their CONTENT key (`content:<hash>`) because knowledge row ids are
// machine-local; the importer binds them to a local entry with the same
// content hash when one exists. Vote tallies ride per entry content key and
// land per origin machine (kg_peer_votes) — tallies never sum across a
// re-send.
//
// SECURITY: only scrubbed rows ship — every outgoing string passes the
// scrub rule set + secret redaction, a key the scrub would alter never
// ships at all, decant-derived rows ship only when marked scrubbed AND
// active|candidate, and decant SESSION nodes (plus every edge touching
// them) stay machine-local: refs only, never shipped. The landing re-checks
// (defense in depth): key material refuses the row, session nodes refuse.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { redactSecrets } from "../knowledge.ts";
import {
	EDGE_TYPES,
	type EdgeType,
	NODE_KINDS,
	type NodeKind,
	stateRank,
	upsertNode,
} from "./graph.ts";
import { ensureDistillSchema } from "./schema.ts";
import { scrubbed } from "./sink.ts";

const NodeKeySchema = z
	.object({ kind: z.enum(NODE_KINDS), key: z.string().min(1).max(400) })
	.strict();

const WireNodeSchema = NodeKeySchema.extend({
	label: z.string().max(400),
	props: z.record(z.string(), z.unknown()),
	hash: z.string().max(128).nullable(),
	state: z.string().max(32),
	last_seen: z.number(),
}).strict();

const WireEdgeSchema = z
	.object({
		src: NodeKeySchema,
		dst: NodeKeySchema,
		type: z.enum(EDGE_TYPES),
		weight: z.number(),
		state: z.enum(["candidate", "active", "rejected"]),
		confidence: z.number().nullable(),
		created_by: z.string().max(80),
		evidence_ref: z.string().max(400).nullable(),
		at: z.number(),
	})
	.strict();

const WireVoteSchema = z
	.object({
		key: z.string().min(1).max(200),
		up: z.number().int().min(0),
		down: z.number().int().min(0),
		down_lanes: z.number().int().min(0),
		at: z.number(),
	})
	.strict();

export const MAX_WIRE_ROWS = 5000;

export const GraphDeltaSchema = z
	.object({
		nodes: z.array(WireNodeSchema),
		edges: z.array(WireEdgeSchema),
		votes: z.array(WireVoteSchema).default([]),
	})
	.strict()
	.refine(
		(d) => d.nodes.length + d.edges.length + d.votes.length <= MAX_WIRE_ROWS,
		{ message: `at most ${String(MAX_WIRE_ROWS)} rows per delta` },
	);
export type GraphDelta = z.infer<typeof GraphDeltaSchema>;
type WireNode = z.infer<typeof WireNodeSchema>;
type WireEdge = z.infer<typeof WireEdgeSchema>;
type WireVote = z.infer<typeof WireVoteSchema>;

export const wireRows = (d: GraphDelta): number =>
	d.nodes.length + d.edges.length + d.votes.length;

/** Sync precedence: active > candidate > rejected (anything else lowest). */
const SYNC_RANK: Record<string, number> = {
	active: 3,
	candidate: 2,
	rejected: 1,
};
const syncRank = (s: string): number => SYNC_RANK[s] ?? 0;
const wins = (
	inc: { state: string; t: number },
	cur: { state: string; t: number },
): boolean => {
	const r = syncRank(inc.state) - syncRank(cur.state);
	return r > 0 || (r === 0 && inc.t > cur.t);
};

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

interface RawEdge {
	src: number;
	dst: number;
	type: EdgeType;
	weight: number;
	state: "candidate" | "active" | "rejected";
	confidence: number | null;
	created_by: string;
	evidence_ref: string | null;
	at: number;
}

const scrubDeep = (v: unknown): unknown => {
	if (typeof v === "string") return scrubbed(v);
	if (Array.isArray(v)) return v.map(scrubDeep);
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]),
		);
	return v;
};

const exportable = (n: RawNode): boolean => {
	if (n.kind === "session") return false; // refs only, never shipped
	if (n.kind === "entry" && !n.hash) return false;
	if (n.kind !== "entry" && scrubbed(n.key) !== n.key) return false;
	const p = JSON.parse(n.props) as { origin?: string; scrubbed?: boolean };
	if (p.origin !== "decant") return true;
	return (
		p.scrubbed === true && (n.state === "active" || n.state === "candidate")
	);
};

const wireKey = (n: RawNode): { kind: NodeKind; key: string } =>
	n.kind === "entry"
		? { kind: n.kind, key: `content:${n.hash ?? ""}` }
		: { kind: n.kind, key: n.key };

const wireNode = (n: RawNode): WireNode => ({
	...wireKey(n),
	label: scrubbed(n.label),
	props: scrubDeep(JSON.parse(n.props)) as Record<string, unknown>,
	hash: n.hash,
	state: n.state,
	last_seen: n.last_seen,
});

const hasTable = (db: Database, name: string): boolean =>
	db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name) !== null;

function voteRows(db: Database, since: number): WireVote[] {
	if (!hasTable(db, "knowledge_votes")) return [];
	const rows = db
		.query(
			"SELECT n.hash AS hash, SUM(v.vote = 'up') AS up, SUM(v.vote = 'down') AS down, COUNT(DISTINCT CASE WHEN v.vote = 'down' THEN v.lane END) AS down_lanes, MAX(v.ts) AS at FROM knowledge_votes v JOIN kg_nodes n ON n.kind = 'entry' AND n.ref = 'knowledge:' || v.entry_id WHERE n.hash IS NOT NULL GROUP BY v.entry_id HAVING MAX(v.ts) >= ?",
		)
		.all(since) as {
		hash: string;
		up: number;
		down: number;
		down_lanes: number;
		at: number;
	}[];
	return rows.map((r) => ({
		key: `content:${r.hash}`,
		up: r.up,
		down: r.down,
		down_lanes: r.down_lanes,
		at: r.at,
	}));
}

export interface WireBatch {
	delta: GraphDelta;
	/** the next `since` — stamp it only after every target acked */
	cursor: number;
	truncated: boolean;
}

/** Everything changed at/after `since` that may leave this machine, in time
 *  order, bounded to ~maxBytes of JSON. An edge carries its endpoint nodes
 *  (the peer cannot bind an edge to a node it never saw). A truncated batch
 *  sets the cursor to the first row left behind (ties re-send; the landing
 *  is idempotent). */
export function collectGraphWire(
	db: Database,
	since: number,
	maxBytes = Number.POSITIVE_INFINITY,
): WireBatch {
	const all = db
		.query(
			"SELECT id, kind, key, label, props, hash, state, last_seen FROM kg_nodes",
		)
		.all() as RawNode[];
	const ok = new Map(all.filter(exportable).map((n) => [n.id, n]));
	type Item =
		| { t: number; node: RawNode }
		| { t: number; edge: RawEdge }
		| { t: number; vote: WireVote };
	const items: Item[] = [];
	for (const n of ok.values())
		if (n.last_seen >= since) items.push({ t: n.last_seen, node: n });
	for (const e of db
		.query(
			"SELECT src, dst, type, weight, state, confidence, created_by, evidence_ref, at FROM kg_edges WHERE at >= ?",
		)
		.all(since) as RawEdge[]) {
		if (!ok.has(e.src) || !ok.has(e.dst)) continue;
		if (e.created_by === "decant" && e.state === "rejected") continue;
		items.push({ t: e.at, edge: e });
	}
	for (const v of voteRows(db, since)) items.push({ t: v.at, vote: v });
	items.sort((a, b) => a.t - b.t);

	const delta: GraphDelta = { nodes: [], edges: [], votes: [] };
	const sent = new Set<number>();
	let bytes = 0;
	const pushNode = (n: RawNode): void => {
		if (sent.has(n.id)) return;
		sent.add(n.id);
		const w = wireNode(n);
		bytes += JSON.stringify(w).length;
		delta.nodes.push(w);
	};
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (!it) continue;
		if (bytes >= maxBytes || wireRows(delta) >= MAX_WIRE_ROWS - 3) {
			const cursor = it.t > since ? it.t : since + 1;
			return { delta, cursor, truncated: true };
		}
		if ("node" in it) pushNode(it.node);
		else if ("vote" in it) {
			bytes += JSON.stringify(it.vote).length;
			delta.votes.push(it.vote);
		} else {
			const s = ok.get(it.edge.src);
			const d = ok.get(it.edge.dst);
			if (!s || !d) continue;
			pushNode(s);
			pushNode(d);
			const ref = it.edge.evidence_ref;
			const w: WireEdge = {
				...it.edge,
				src: wireKey(s),
				dst: wireKey(d),
				evidence_ref:
					ref === null || ref.startsWith("decant:") ? null : scrubbed(ref),
			};
			bytes += JSON.stringify(w).length;
			delta.edges.push(w);
		}
	}
	const last = items.at(-1)?.t;
	return {
		delta,
		cursor: last === undefined ? since : Math.max(since, last + 1),
		truncated: false,
	};
}

/** Unbounded export (tests, operator dumps). */
export const exportGraphDelta = (db: Database, since: number): GraphDelta =>
	collectGraphWire(db, since).delta;

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

/** Landing re-check: key material anywhere in the row refuses it. */
const carriesKey = (...parts: (string | null)[]): boolean => {
	const r = redactSecrets(parts.filter((p) => p !== null).join("\n"));
	return r.rejected || r.hits.length > 0;
};

export interface LandCounts {
	received: number;
	applied: number;
	rejected: number;
}

/** Apply a peer's delta under the sync precedence. `origin` = the sending
 *  machine (vote tallies land per origin). Edges resolve by the graph's own
 *  stateRank (human rejection is terminal — a machine re-observation never
 *  revives it), nodes by the sync rank active > candidate > rejected then
 *  last-writer. Throws on a malformed delta — landGraphWire is the
 *  safeParse face. */
export function importGraphDelta(
	db: Database,
	raw: unknown,
	origin = "peer",
): LandCounts {
	const delta = GraphDeltaSchema.parse(raw);
	ensureDistillSchema(db);
	const c: LandCounts = { received: wireRows(delta), applied: 0, rejected: 0 };
	db.transaction(() => {
		for (const n of delta.nodes) {
			const props = JSON.stringify(n.props);
			if (n.kind === "session" || carriesKey(n.key, n.label, props)) {
				c.rejected++;
				continue;
			}
			const id = localId(db, n);
			const cur =
				id === null
					? null
					: (db
							.query("SELECT state, last_seen FROM kg_nodes WHERE id = ?")
							.get(id) as { state: string; last_seen: number });
			if (
				cur &&
				!wins(
					{ state: n.state, t: n.last_seen },
					{ state: cur.state, t: cur.last_seen },
				)
			) {
				// precedence-lost = the peer already holds a newer row — success
				// for convergence, never a rejection (the ack sum must hold)
				c.applied++;
				continue;
			}
			if (id !== null)
				db.query(
					"UPDATE kg_nodes SET label = ?, props = ?, state = ?, last_seen = ? WHERE id = ?",
				).run(scrubbed(n.label), props, n.state, n.last_seen, id);
			else
				upsertNode(
					db,
					{
						kind: n.kind,
						key: n.key,
						label: scrubbed(n.label),
						props: n.props,
						hash: n.hash,
						state: n.state,
					},
					n.last_seen,
				);
			c.applied++;
		}
		for (const e of delta.edges) {
			if (carriesKey(e.evidence_ref, e.created_by)) {
				c.rejected++;
				continue;
			}
			const src = localId(db, e.src);
			const dst = localId(db, e.dst);
			// a row the hub cannot place is an idempotent no-op — counted applied
			// so the strict ack sum holds (the spoke never wedges on a row the
			// peer legitimately holds better, or a node it never received)
			if (src === null || dst === null) {
				c.applied++;
				continue;
			}
			const cur = db
				.query(
					"SELECT state, at FROM kg_edges WHERE src = ? AND dst = ? AND type = ?",
				)
				.get(src, dst, e.type) as { state: string; at: number } | null;
			if (cur) {
				const r = stateRank(e.state) - stateRank(cur.state);
				if (r < 0 || (r === 0 && cur.at >= e.at)) {
					c.applied++;
					continue;
				}
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
			db.query(
				"UPDATE kg_nodes SET edge_at = MAX(edge_at, ?) WHERE id IN (?, ?)",
			).run(e.at, src, dst);
			c.applied++;
		}
		for (const v of delta.votes) {
			// a stale tally (not newer than the row we hold) is a no-op for
			// convergence, never a rejection — the ack sum must hold on re-sends
			db.query(
				"INSERT INTO kg_peer_votes (key, origin, up, down, down_lanes, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key, origin) DO UPDATE SET up = excluded.up, down = excluded.down, down_lanes = excluded.down_lanes, at = excluded.at WHERE excluded.at > kg_peer_votes.at",
			).run(v.key, origin, v.up, v.down, v.down_lanes, v.at);
			c.applied++;
		}
	})();
	return c;
}

/** The hub sink's landing face (knowledge-api POST /graph): zod safeParse,
 *  loud refusal with the prettified issue, counts for the spoke's ack. */
export function landGraphWire(
	db: Database,
	raw: unknown,
	origin: string,
): { ok: boolean; error?: string; counts?: LandCounts } {
	const parsed = GraphDeltaSchema.safeParse(raw);
	if (!parsed.success)
		return { ok: false, error: z.prettifyError(parsed.error) };
	return { ok: true, counts: importGraphDelta(db, parsed.data, origin) };
}
