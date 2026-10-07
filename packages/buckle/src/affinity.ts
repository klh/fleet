// src/affinity.ts — W237 prefix-affinity dispatch: lanes sharing a packet
// prefix ride the same provider identity within a TTL window, so the
// provider's KV cache is hit instead of rebuilt. The key is the packet
// block's byte hash (byte-stable packets — the preseed render law — hash
// equal when the TTL window serves the same packet bytes). The router only
// REORDERS the W140 selection (never injects a candidate), never touches a
// `must` hint (law 2), and skips a bound target that left the selection or
// benched into cooldown. BUCKLE_AFFINITY=off kill switch;
// BUCKLE_AFFINITY_TTL_S overrides the window (default 300s — the preseed
// TTL). No packet block → no key → zero touch (pass-through doctrine).
import { packetBlockOf } from "./align.ts";
import type { CandidateRow } from "./candidates.ts";
import type { RouteSelection } from "./decide.ts";

type AnyRec = Record<string, unknown>;

export const AFFINITY_TTL_S_DEFAULT = 300;
const MAP_CAP = 4096;

export function affinityOn(): boolean {
	return process.env.BUCKLE_AFFINITY !== "off";
}

export function affinityTtlMs(): number {
	const raw = Number(process.env.BUCKLE_AFFINITY_TTL_S ?? "");
	if (!Number.isFinite(raw) || raw <= 0) return AFFINITY_TTL_S_DEFAULT * 1000;
	return raw * 1000;
}
/** Packet identity as the affinity key: sha256-12 of the prefix-position
 *  packet block's bytes. null = no packet, no affinity. */
export function affKeyOf(body: AnyRec): string | null {
	const ref = packetBlockOf(body);
	if (!ref) return null;
	const text = ref.block.text;
	if (typeof text !== "string") return null;
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
}
/** Prefix-affinity memo: key → (candidate id, bind on delivery). Entries
 *  expire after ttlMs; the map is LRU-bounded (bind refreshes recency, the
 *  oldest key is evicted and MAP_CAP never grows). */
export class PrefixAffinity {
	private readonly entries = new Map<string, { id: string; at: number }>();

	constructor(
		private readonly ttlMs: number = affinityTtlMs(),
		private readonly now: () => number = Date.now,
	) {}

	/** The candidate currently bound to this prefix, or null (expired
	 *  entries are dropped on probe). */
	probe(key: string | null): string | null {
		if (key === null) return null;
		const e = this.entries.get(key);
		if (!e) return null;
		if (this.now() - e.at >= this.ttlMs) {
			this.entries.delete(key);
			return null;
		}
		return e.id;
	}

	/** Bind a delivered candidate to the prefix (LRU refresh). */
	bind(key: string | null, candidateId: string): void {
		this.entries.delete(key);
		this.entries.set(key, { id: candidateId, at: this.now() });
		if (this.entries.size > MAP_CAP) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}
}
/** Reorder the selection so the bound candidate delivers first — within the
 *  already-selected candidate set, healthy rows only, never on `must`
 *  (law 2: no substitution beyond the hint). Returns the SAME selection
 *  object when nothing applied (identity preserved for skip accounting). */
export function applyAffinity(
	sel: RouteSelection,
	id: string | null,
): RouteSelection {
	if (!id || sel.verb === "must") return sel;
	const i = sel.ordered.findIndex((r) => r.candidate_id === id);
	if (i <= 0) return sel; // absent, or already head
	const row = sel.ordered[i] as CandidateRow | undefined;
	if (!row?.healthy) return sel;
	const ordered = [
		row,
		...sel.ordered.slice(0, i),
		...sel.ordered.slice(i + 1),
	];
	const head = ordered[0];
	if (!head) return sel;
	return {
		...sel,
		ordered,
		head,
		top: ordered.slice(0, 3).map((c) => c.candidate_id),
		why: `${sel.why}; prefix-affinity → ${id}`,
	};
}
