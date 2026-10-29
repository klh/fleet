// distill/jobs-local.ts — the jobs that need no chat model:
//   extract    deterministic entities + about/applies_to/mentions edges
//   staleness  re-hash source_refs → `hash drift` marks; missing code nodes
//   crosslink  embeddings (+ rerank) → `related` candidate edges
//   dedupe     near-duplicate pairs → a proposal, NEVER a delete
// Each unit is idempotent: re-running it on unchanged input writes the same
// rows (upserts keyed by node/edge identity, proposals one-open-per-row).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { consolidateTokens, jaccardOverlap } from "../knowledge-consolidate.ts";
import { trustOf } from "../knowledge.ts";
import type { JobContext, Prepare, Unit } from "./context.ts";
import { extractEntities, refPath, relationFor } from "./extract.ts";
import { type NodeRow, nodeById, upsertEdge, upsertNode } from "./graph.ts";
import { knowledgeIdOf, knowledgeRow } from "./sink.ts";
import { putVector, vectorHash } from "./vectors.ts";

export const entryText = (ctx: JobContext, node: NodeRow): string | null => {
	const id = knowledgeIdOf(node.ref);
	const row = id === null ? null : knowledgeRow(ctx.db, id);
	return row ? `${row.topic}\n${row.fact}` : null;
};

const roots = (ctx: JobContext): string[] =>
	ctx.cfg.repo_roots.length ? ctx.cfg.repo_roots : [process.cwd()];

export const extractUnit: Unit = async (ctx, node) => {
	const kid = knowledgeIdOf(node.ref);
	const row = kid === null ? null : knowledgeRow(ctx.db, kid);
	if (!row) return { outcome: "missing" };
	const now = ctx.now();
	let n = 0;
	ctx.db.transaction(() => {
		const about = refPath(row.source_ref);
		if (about) {
			const id = upsertNode(ctx.db, { kind: "code", key: about }, now);
			upsertEdge(
				ctx.db,
				{
					src: node.id,
					dst: id,
					type: "about",
					createdBy: "extract",
					evidenceRef: row.source_ref,
					state: "active",
				},
				now,
			);
			n++;
		}
		const text = `${row.topic}\n${row.fact}\n${row.source_ref ?? ""}`;
		for (const e of extractEntities(text)) {
			if (e.kind === "code" && e.key === about) continue;
			const id = upsertNode(
				ctx.db,
				{ kind: e.kind, key: e.key, label: e.label },
				now,
			);
			upsertEdge(
				ctx.db,
				{
					src: node.id,
					dst: id,
					type: relationFor(e, {
						originKind: row.origin_kind,
						topic: row.topic,
					}),
					createdBy: "extract",
					state: "active",
				},
				now,
			);
			n++;
		}
		if (row.origin_system) {
			const id = upsertNode(
				ctx.db,
				{ kind: "machine", key: row.origin_system },
				now,
			);
			upsertEdge(
				ctx.db,
				{
					src: node.id,
					dst: id,
					type: "observed_on",
					createdBy: "extract",
					state: "active",
				},
				now,
			);
			n++;
		}
		// lesson ↔ session: the entry's origin sid is a decant session id
		if (row.origin_sid) {
			const s = ctx.db
				.query(
					"SELECT id FROM kg_nodes WHERE kind = 'session' AND key LIKE '%/' || ? LIMIT 1",
				)
				.get(row.origin_sid) as { id: number } | null;
			if (s) {
				upsertEdge(
					ctx.db,
					{
						src: node.id,
						dst: s.id,
						type: "derived_from",
						createdBy: "extract",
						evidenceRef: `decant:session:${row.origin_sid}`,
						state: "active",
					},
					now,
				);
				n++;
			}
		}
	})();
	return { outcome: `entities:${String(n)}` };
};

export const DRIFT_REASON = "hash drift: source changed since index (distill)";

export const stalenessUnit: Unit = async (ctx, node) => {
	if (node.kind === "code") {
		const missing = !roots(ctx).some((r) => existsSync(join(r, node.key)));
		const props = { ...(JSON.parse(node.props) as object), missing };
		ctx.db
			.query("UPDATE kg_nodes SET props = ? WHERE id = ?")
			.run(JSON.stringify(props), node.id);
		return { outcome: missing ? "missing" : "present" };
	}
	const kid = knowledgeIdOf(node.ref);
	const row = kid === null ? null : knowledgeRow(ctx.db, kid);
	if (!row?.source_ref || !row.source_hash) return { outcome: "unverifiable" };
	let trust: string = "unverified";
	for (const r of roots(ctx)) {
		trust = trustOf(row.source_ref, row.source_hash, r);
		if (trust !== "unverified") break;
	}
	if (trust === "drift" && row.stale_at === null) {
		ctx.db
			.query("UPDATE knowledge SET stale_at = ?, stale_reason = ? WHERE id = ?")
			.run(ctx.now(), DRIFT_REASON, row.id);
		return { outcome: "drift" };
	}
	if (trust === "verified" && row.stale_reason === DRIFT_REASON) {
		ctx.db
			.query(
				"UPDATE knowledge SET stale_at = NULL, stale_reason = NULL WHERE id = ?",
			)
			.run(row.id);
		return { outcome: "verified:cleared" };
	}
	return { outcome: trust };
};

/** One batched embeddings call for every batch entry whose vector is stale. */
export const crosslinkPrepare: Prepare = async (ctx, batch) => {
	const todo: { id: number; hash: string; text: string }[] = [];
	for (const n of batch) {
		const text = entryText(ctx, n);
		if (text && n.hash && vectorHash(ctx.db, n.id) !== n.hash)
			todo.push({ id: n.id, hash: n.hash, text });
	}
	if (!todo.length) return;
	const vecs = await ctx.clients.embed.embed(todo.map((t) => t.text));
	ctx.db.transaction(() => {
		todo.forEach((t, i) => {
			const v = vecs[i];
			if (!v) return;
			putVector(ctx.db, t.id, t.hash, v);
			ctx.vectors.set(t.id, v);
		});
	})();
};

export const crosslinkUnit: Unit = async (ctx, node) => {
	const c = ctx.cfg;
	const near = ctx.vectors.topK(node.id, c.neighbours_k, c.related_min * 0.85);
	if (!near.length) return { outcome: "linked:0" };
	let scores = near.map((x) => x.score);
	if (ctx.clients.rerank) {
		const query = entryText(ctx, node) ?? node.label;
		const docs = near.map((x) => {
			const other = nodeById(ctx.db, x.id);
			return other ? (entryText(ctx, other) ?? other.label) : "";
		});
		const rr = await ctx.clients.rerank.rerank(query, docs);
		// a missing/garbage rerank score falls back to the cosine
		scores = near.map((x, i) => {
			const r = rr[i];
			return r !== undefined && r >= 0 && r <= 1 ? (r + x.score) / 2 : x.score;
		});
	}
	const now = ctx.now();
	let n = 0;
	ctx.db.transaction(() => {
		near.forEach((x, i) => {
			const score = scores[i] ?? x.score;
			if (score < c.related_min) return;
			// one undirected related edge per pair: canonical (low → high)
			const [src, dst] = node.id < x.id ? [node.id, x.id] : [x.id, node.id];
			upsertEdge(
				ctx.db,
				{
					src,
					dst,
					type: "related",
					weight: Math.round(score * 1000) / 1000,
					confidence: x.score,
					createdBy: ctx.clients.rerank
						? "crosslink:embed+rerank"
						: "crosslink:embed",
					state: "candidate",
				},
				now,
			);
			n++;
		});
	})();
	return { outcome: `linked:${String(n)}` };
};

const KSTATE_RANK: Record<string, number> = { active: 2, candidate: 1 };

export const dedupeUnit: Unit = async (ctx, node) => {
	const kid = knowledgeIdOf(node.ref);
	const me = kid === null ? null : knowledgeRow(ctx.db, kid);
	if (!me) return { outcome: "missing" };
	const pairs = ctx.db
		.query(
			"SELECT CASE WHEN src = ?1 THEN dst ELSE src END AS other, weight FROM kg_edges WHERE (src = ?1 OR dst = ?1) AND type = 'related' AND state != 'rejected' AND weight >= ?2",
		)
		.all(node.id, ctx.cfg.duplicate_min) as { other: number; weight: number }[];
	let proposed = 0;
	for (const p of pairs) {
		const on = nodeById(ctx.db, p.other);
		const okid = on ? knowledgeIdOf(on.ref) : null;
		const other = okid === null ? null : knowledgeRow(ctx.db, okid);
		if (!on || !other) continue;
		const overlap = jaccardOverlap(
			consolidateTokens(`${me.topic} ${me.fact}`),
			consolidateTokens(`${other.topic} ${other.fact}`),
		);
		if (overlap < 0.5) continue;
		const meFirst =
			(KSTATE_RANK[me.state] ?? 0) - (KSTATE_RANK[other.state] ?? 0) ||
			me.confidence - other.confidence ||
			other.id - me.id;
		const [keep, dup, dupNode, keepNode] =
			meFirst >= 0 ? [me, other, on.id, node.id] : [other, me, node.id, on.id];
		upsertEdge(ctx.db, {
			src: dupNode,
			dst: keepNode,
			type: "duplicate_of",
			weight: p.weight,
			confidence: overlap,
			createdBy: "dedupe",
			state: "candidate",
		});
		if (
			ctx.sink.propose({
				knowledgeId: dup.id,
				kind: "distill-dedupe",
				score: p.weight,
				reason: `near-duplicate of #${String(keep.id)} (similarity ${p.weight.toFixed(2)}, overlap ${overlap.toFixed(2)}) — approve retires #${String(dup.id)} superseded-by #${String(keep.id)}`,
				payload: {
					keep: keep.id,
					duplicate: dup.id,
					similarity: p.weight,
					overlap,
				},
			})
		)
			proposed++;
	}
	return { outcome: `proposed:${String(proposed)}` };
};
