// hooks/lib/knowledge-merkle.ts — W1214: hub-to-hub knowledge anti-entropy
// over the CAS'd fact namespace (the knowledge_claims aggregate W1213 lands).
// The Dynamo/Cassandra pattern, sized to this fleet: the claim hash IS the
// key; the hash space is sharded by its first byte (256 shards), each shard
// owns a fixed-depth Merkle tree over the NEXT byte (256 leaf slots), and a
// leaf holds the CONTENT hash of the canonical row — not just key presence —
// so two hubs holding the same key with drifted content also find each other.
// On hub pair contact: exchange roots; equal → stop (nothing crosses the
// wire); unequal → descend only the divergent shards/slots and exchange the
// rows under them, both directions, through the W1213 provenance rules as a
// CONTENT merge (see mergePeerRows). The merge is commutative and idempotent
// by construction — confidence is a max-register, provenance a grow-only set
// with max-ts per key, tombstone/origin are DERIVED from the provenance
// union — so no CRDT counters are needed (the W1214 "decide then": decided,
// they are not).
import { createHash } from "node:crypto";
import type { ProvenanceEntry } from "./knowledge-roll.ts";

// ─── address space ──────────────────────────────────────────────────────────

/** Shard = first hash byte (256 ranges). Slot = second hash byte (256 leaf
 *  slots per shard). Both hex-aligned so slot lookups ride the claim_hash
 *  UNIQUE index via a LIKE prefix. */
export const AE_SHARDS = 256;
export const AE_SLOTS = 256;
/** Per-shard flat tree: nodes[0] = root, children of i at 2i+1 / 2i+2,
 *  leaves at [AE_SLOTS-1 .. 2*AE_SLOTS-2]. Fixed shape (depth 8) — every hub
 *  builds byte-identical structure for any corpus. */
export const AE_TREE_NODES = 2 * AE_SLOTS - 1;

export const aeShardOf = (hash: string): number =>
	Number.parseInt(hash.slice(0, 2), 16);
export const aeSlotOf = (hash: string): number =>
	Number.parseInt(hash.slice(2, 4), 16);

/** The empty-slot leaf hash (sha256 of ""), shared constant. */
export const AE_EMPTY_LEAF = createHash("sha256").update("").digest("hex");

// ─── canonical row + content hash ───────────────────────────────────────────

/** The canonical row shape: the W1213 merged-state fields only. Hub-local
 *  arrival fields (id, ts, updated_at and the display version ordinal) are
 *  excluded ON PURPOSE — they differ between hubs without any knowledge
 *  divergence, and putting them in the content hash would make roots
 *  disagree forever (roots must converge). */
export interface AeRow {
	claim_hash: string;
	evidence_id: string;
	claim: string;
	confidence: number;
	tombstone: boolean;
	tombstone_ts: number | null;
	scope: string;
	origin_machine: string;
	provenance: ProvenanceEntry[];
}

/** The W1213 monotonic rules, as a pure content function: the row is
 *  tombstoned exactly when a retraction event is not older than every
 *  assertion event (ties → the retraction — applyKnown's tie-break), and
 *  origin is the earliest asserter (min ts, then machine). Both are derived
 *  from the provenance union, so merge(A,B) lands both hubs on the SAME
 *  derived state regardless of merge direction. */
export function canonicalRow(row: AeRow): AeRow {
	const prov = normalizeProvenance(row.provenance);
	let maxR = 0;
	let maxA = 0;
	for (const p of prov) {
		if (p.retract) maxR = Math.max(maxR, p.ts);
		else maxA = Math.max(maxA, p.ts);
	}
	const tomb = prov.length > 0 && maxR >= maxA;
	return {
		claim_hash: row.claim_hash,
		evidence_id: row.evidence_id,
		claim: row.claim,
		confidence: row.confidence,
		tombstone: tomb,
		tombstone_ts: tomb ? maxR : null,
		scope: row.scope,
		origin_machine: canonicalOrigin(prov),
		provenance: prov,
	};
}

/** Provenance in union-normal form: one entry per (machine, retract?) key,
 *  each keeping its MAX ts, canonically sorted. Commmutative + idempotent —
 *  normalize(A ∪ B) is the same set however the merge arrived, which is the
 *  property the content hash (and therefore root convergence) rides. */
export function normalizeProvenance(
	prov: ProvenanceEntry[],
): ProvenanceEntry[] {
	const best = new Map<string, ProvenanceEntry>();
	for (const p of prov) {
		if (!p || typeof p.machine !== "string" || !p.machine) continue;
		const k = `${p.machine}\u0000${p.retract ? 1 : 0}`;
		const cur = best.get(k);
		if (!cur || p.ts > cur.ts) best.set(k, p);
	}
	return [...best.values()].sort(
		(a, b) =>
			a.ts - b.ts ||
			(a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0) ||
			(a.retract ? 1 : 0) - (b.retract ? 1 : 0),
	);
}

/** Origin = the earliest event in the union (min ts, then machine name) —
 *  the first asserter; a first-landing tombstone (only a retraction) names
 *  its retractor. Derived, so hubs converge on it like every other field. */
export function canonicalOrigin(prov: ProvenanceEntry[]): string {
	let best: ProvenanceEntry | null = null;
	for (const p of prov) {
		if (!p || typeof p.machine !== "string" || !p.machine) continue;
		if (
			best === null ||
			p.ts < best.ts ||
			(p.ts === best.ts && p.machine < best.machine)
		)
			best = p;
	}
	return best === null ? "" : best.machine;
}

/** Fixed-key-order canonical JSON (JSON.stringify preserves insertion
 *  order), content hash over it. Excluded: claim_hash (the ADDRESS is the
 *  key — the leaf VALUE must stay a pure content function) and every
 *  hub-local field (canonicalRow drops those). */
export function contentHash(row: AeRow): string {
	const c = canonicalRow(row);
	const payload =
		`{"claim":${JSON.stringify(c.claim)}` +
		`,"confidence":${c.confidence}` +
		`,"evidence_id":${JSON.stringify(c.evidence_id)}` +
		`,"origin_machine":${JSON.stringify(c.origin_machine)}` +
		`,"provenance":${JSON.stringify(c.provenance)}` +
		`,"scope":${JSON.stringify(c.scope)}` +
		`,"tombstone":${c.tombstone}` +
		`,"tombstone_ts":${c.tombstone_ts === null ? "null" : c.tombstone_ts}}`;
	return createHash("sha256").update(payload).digest("hex");
}

// ─── the per-shard Merkle trees ─────────────────────────────────────────────

/** One shard's tree from its per-slot leaf hashes. All-empty shards build to
 *  the same constant structure on every hub — empty namespaces compare
 *  equal, and an empty shard on one hub diverges from a populated one. */
export function buildShardNodes(leaves: string[]): string[] {
	const nodes = seededShardNodes();
	for (let s = 0; s < AE_SLOTS; s++)
		if (leaves[s] !== undefined) nodes[AE_SLOTS - 1 + s] = leaves[s];
	return recalcShardNodes(nodes);
}

/** The all-empty shard structure (every slot AE_EMPTY_LEAF). */
export function emptyShardNodes(): string[] {
	return recalcShardNodes(seededShardNodes());
}

function seededShardNodes(): string[] {
	return new Array<string>(AE_TREE_NODES).fill(AE_EMPTY_LEAF);
}

function recalcShardNodes(nodes: string[]): string[] {
	for (let i = AE_SLOTS - 2; i >= 0; i--)
		nodes[i] = createHash("sha256")
			.update(nodes[2 * i + 1] + nodes[2 * i + 2])
			.digest("hex");
	return nodes;
}

/** The hub root binds every shard-root vector, in index order: equal roots
 *  ⇔ equal shard-root vectors (collision resistance) ⇔ equal slot vectors. */
export function aeHubRoot(shardRoots: string[]): string {
	if (shardRoots.length !== AE_SHARDS)
		throw new Error(`aeHubRoot: expected ${AE_SHARDS} shard roots`);
	const h = createHash("sha256");
	for (const r of shardRoots) h.update(r);
	return h.digest("hex");
}

/** Divergent leaf slots between two same-shaped shard trees: walk from the
 *  root; equal subtrees skip whole, unequal ones descend, and only the leaf
 *  level reports — diff cost is O(divergence · depth), never O(corpus). */
export function diffShardTrees(a: string[], b: string[]): number[] {
	if (a.length !== AE_TREE_NODES) throw new Error("malformed local tree");
	if (b.length !== AE_TREE_NODES) throw new Error("malformed remote tree");
	const out: number[] = [];
	const walk = (i: number): void => {
		if (a[i] === b[i]) return;
		if (i >= AE_SLOTS - 1) {
			out.push(i - (AE_SLOTS - 1));
			return;
		}
		walk(2 * i + 1);
		walk(2 * i + 2);
	};
	walk(0);
	return out;
}

// ─── wire shape (the /ae/leaves + /ae/merge payloads) ───────────────────────

/** A row on the anti-entropy wire: the canonical content plus the version
 *  ordinal (used ONLY on insert, and only when its (evidence, version) slot
 *  is free — versions are hub-local display ordinals, never sync state). */
export interface AeWireRow extends AeRow {
	version: number;
}

const AE_ROW_KEYS = [
	"claim_hash",
	"evidence_id",
	"claim",
	"confidence",
	"tombstone",
	"tombstone_ts",
	"scope",
	"origin_machine",
	"provenance",
	"version",
];
const HEX64 = /^[0-9a-f]{64}$/;

/** Strict wire validator — every field present and well-typed, nothing
 *  extra (the W1213 B1 posture: a lax schema is how scope probes landed). */
export function parsePeerRow(w: unknown): AeWireRow | null {
	if (!w || typeof w !== "object" || Array.isArray(w)) return null;
	const r = w as Record<string, unknown>;
	for (const k of AE_ROW_KEYS) if (!(k in r)) return null;
	for (const k of Object.keys(r)) if (!AE_ROW_KEYS.includes(k)) return null;
	if (typeof r.claim_hash !== "string" || !HEX64.test(r.claim_hash))
		return null;
	if (typeof r.version !== "number" || !Number.isInteger(r.version))
		return null;
	if (r.version < 1) return null;
	return finishPeerRow(r);
}

/** Shared tail of the validator: content fields, tombstone/scope shape, and
 *  the provenance list. Kept separate so each write stays small. */
function finishPeerRow(r: Record<string, unknown>): AeWireRow | null {
	const id = r.evidence_id;
	if (typeof id !== "string" || !id.trim() || id.length > 256) return null;
	const c = r.claim;
	if (typeof c !== "string" || !c.trim() || c.length > 2000) return null;
	const conf = r.confidence;
	if (
		typeof conf !== "number" ||
		!Number.isFinite(conf) ||
		conf < 0 ||
		conf > 1
	)
		return null;
	if (typeof r.tombstone !== "boolean") return null;
	if (r.tombstone_ts !== null && typeof r.tombstone_ts !== "number")
		return null;
	if (r.scope !== "fleet" && r.scope !== "machine") return null;
	if (typeof r.origin_machine !== "string" || r.origin_machine.length > 128)
		return null;
	const prov = parsePeerProvenance(r.provenance);
	if (prov === null) return null;
	return {
		claim_hash: r.claim_hash,
		evidence_id: id,
		claim: c,
		confidence: conf,
		tombstone: r.tombstone,
		tombstone_ts: r.tombstone_ts,
		scope: r.scope,
		origin_machine: r.origin_machine,
		provenance: prov,
		version: r.version,
	};
}

/** Provenance entries are {machine, ts, retract?} — the same shape W1213
 *  stores. Validate strictly; the list may not be empty (a claim row without
 *  provenance cannot exist on a W1213 hub, so its absence on the wire means
 *  corruption). */
export function parsePeerProvenance(w: unknown): ProvenanceEntry[] | null {
	if (!Array.isArray(w) || w.length === 0 || w.length > 500) return null;
	const out: ProvenanceEntry[] = [];
	for (const p of w) {
		if (!p || typeof p !== "object" || Array.isArray(p)) return null;
		const e = p as Record<string, unknown>;
		if (typeof e.machine !== "string" || !e.machine || e.machine.length > 128)
			return null;
		if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return null;
		if (e.retract !== undefined && typeof e.retract !== "boolean") return null;
		out.push(
			e.retract === undefined
				? { machine: e.machine, ts: e.ts }
				: (e as ProvenanceEntry),
		);
	}
	return out;
}

/** db row → wire row (the /ae/leaves response). Null when the stored
 *  provenance JSON is corrupt — the row never ships (honest degradation:
 *  nothing partial crosses, the sync-side posture). */
export function claimRowToWire(row: {
	claim_hash: string;
	evidence_id: string;
	claim: string;
	confidence: number;
	version: number;
	tombstone: number;
	origin_machine: string;
	provenance: string;
	tombstone_ts: number | null;
	scope: string;
}): AeWireRow | null {
	let prov: ProvenanceEntry[] = [];
	try {
		prov = JSON.parse(row.provenance) as ProvenanceEntry[];
	} catch {
		return null;
	}
	return parsePeerRow({
		claim_hash: row.claim_hash,
		evidence_id: row.evidence_id,
		claim: row.claim,
		confidence: row.confidence,
		tombstone: row.tombstone === 1,
		tombstone_ts: row.tombstone_ts,
		scope: row.scope,
		origin_machine: row.origin_machine,
		provenance: prov,
		version: row.version,
	});
}
