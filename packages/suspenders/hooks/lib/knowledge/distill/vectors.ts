// distill/vectors.ts — entry embeddings stored beside the graph (Float32
// blobs keyed by node id + the content hash they were computed from) and a
// brute-force cosine top-k. sqlite-vec is not in the fleet's dependency
// set; at hub scale (≈10⁴ entries × 384–1024 dims) a linear scan over an
// in-memory matrix is milliseconds, and the matrix is loaded once per run.
import type { Database } from "bun:sqlite";

export function putVector(
	db: Database,
	nodeId: number,
	hash: string,
	vec: number[],
): void {
	const f = Float32Array.from(vec);
	db.query(
		"INSERT INTO kg_vectors (node_id, hash, dim, vec) VALUES (?, ?, ?, ?) ON CONFLICT (node_id) DO UPDATE SET hash = excluded.hash, dim = excluded.dim, vec = excluded.vec",
	).run(nodeId, hash, f.length, new Uint8Array(f.buffer));
}

/** The stored vector's hash (null = none) — embed only when it moved. */
export const vectorHash = (db: Database, nodeId: number): string | null =>
	(
		db.query("SELECT hash FROM kg_vectors WHERE node_id = ?").get(nodeId) as {
			hash: string;
		} | null
	)?.hash ?? null;

const asFloats = (blob: Uint8Array): Float32Array =>
	new Float32Array(
		blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
	);

const norm = (v: Float32Array): number => {
	let s = 0;
	for (const x of v) s += x * x;
	return Math.sqrt(s) || 1;
};

/** One run's view of the entry vectors (live entries only). */
export class VectorIndex {
	private ids: number[] = [];
	private vecs: Float32Array[] = [];
	private norms: number[] = [];

	constructor(private readonly db: Database) {
		this.reload();
	}

	reload(): void {
		const rows = this.db
			.query(
				"SELECT v.node_id AS id, v.vec AS vec FROM kg_vectors v JOIN kg_nodes n ON n.id = v.node_id WHERE n.kind = 'entry' AND n.state = 'active'",
			)
			.all() as { id: number; vec: Uint8Array }[];
		this.ids = rows.map((r) => r.id);
		this.vecs = rows.map((r) => asFloats(r.vec));
		this.norms = this.vecs.map(norm);
	}

	/** Insert/replace one vector in the in-memory view. */
	set(id: number, vec: number[]): void {
		const f = Float32Array.from(vec);
		const at = this.ids.indexOf(id);
		if (at === -1) {
			this.ids.push(id);
			this.vecs.push(f);
			this.norms.push(norm(f));
			return;
		}
		this.vecs[at] = f;
		this.norms[at] = norm(f);
	}

	get(id: number): Float32Array | null {
		const at = this.ids.indexOf(id);
		return at === -1 ? null : (this.vecs[at] ?? null);
	}

	/** top-k cosine neighbours of `id` (excluding itself) above `min`. */
	topK(id: number, k: number, min: number): { id: number; score: number }[] {
		const q = this.get(id);
		if (!q) return [];
		const qn = norm(q);
		const out: { id: number; score: number }[] = [];
		for (let i = 0; i < this.ids.length; i++) {
			const other = this.ids[i];
			const v = this.vecs[i];
			if (other === undefined || other === id || !v || v.length !== q.length)
				continue;
			let dot = 0;
			for (let j = 0; j < q.length; j++) dot += (q[j] ?? 0) * (v[j] ?? 0);
			const score = dot / (qn * (this.norms[i] ?? 1));
			if (score >= min) out.push({ id: other, score });
		}
		return out.sort((a, b) => b.score - a.score).slice(0, k);
	}
}
