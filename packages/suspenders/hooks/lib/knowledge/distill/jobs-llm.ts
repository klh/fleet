// distill/jobs-llm.ts — the jobs that spend chat tokens (budget-gated):
//   contradiction  linked pairs the model judges contradictory → a
//                  `contradicts` candidate edge + a proposal for a human
//   distill        a cluster of related entries → ONE distilled lesson,
//                  through the Kev gate, landing as state `candidate` with
//                  provenance to every member and derived_from edges
// Model-made edges start as `candidate`. Judged pairs / distilled clusters
// are remembered by content signature, so an unchanged input never spends
// twice; a changed member re-opens it.
import { z } from "zod";
import { jsonObject } from "./clients.ts";
import type { JobContext, Unit } from "./context.ts";
import { nodeById, type NodeRow, upsertEdge, upsertNode } from "./graph.ts";
import { type KnowledgeRow, knowledgeIdOf, knowledgeRow, sha } from "./sink.ts";

export const ContradictionVerdictSchema = z
	.object({
		contradicts: z.boolean(),
		reason: z.string().max(600).default(""),
	})
	.loose();

export const DistilledLessonSchema = z.union([
	z.object({ skip: z.literal(true) }).loose(),
	z
		.object({
			topic: z.string().min(3).max(120),
			fact: z.string().min(10).max(800),
			confidence: z.number().min(0).max(1).optional(),
		})
		.loose(),
]);

const CONTRADICTION_SYSTEM =
	'You compare two knowledge entries from an engineering fleet. Answer ONLY a JSON object {"contradicts": boolean, "reason": string}. contradicts=true only when both cannot be true at once about the same thing (not when one is more specific, newer, or about a different scope).';

const DISTILL_SYSTEM =
	'You distill related engineering knowledge entries into ONE reusable lesson for other agents. Answer ONLY a JSON object {"topic": string (<=80 chars), "fact": string (<=400 chars, concrete: what, where, why), "confidence": 0..1}. Use only what the entries state; never invent paths or numbers. If the entries share no transferable lesson answer {"skip": true}.';

interface Member {
	node: NodeRow;
	row: KnowledgeRow;
}

const memberOf = (ctx: JobContext, id: number): Member | null => {
	const node = nodeById(ctx.db, id);
	const kid = node ? knowledgeIdOf(node.ref) : null;
	const row = kid === null ? null : knowledgeRow(ctx.db, kid);
	return node && row ? { node, row } : null;
};

const render = (m: Member, i: number): string =>
	`[${String(i + 1)}] #${String(m.row.id)} ${m.row.topic}\n${m.row.fact}${m.row.source_ref ? `\nsource: ${m.row.source_ref}` : ""}`;

/** related neighbours of a node above `min`, strongest first */
const relatedOf = (
	ctx: JobContext,
	nodeId: number,
	min: number,
): { other: number; weight: number }[] =>
	ctx.db
		.query(
			"SELECT CASE WHEN src = ?1 THEN dst ELSE src END AS other, weight FROM kg_edges WHERE (src = ?1 OR dst = ?1) AND type = 'related' AND state != 'rejected' AND weight >= ?2 ORDER BY weight DESC",
		)
		.all(nodeId, min) as { other: number; weight: number }[];

const rankOf = (r: KnowledgeRow): number =>
	(r.state === "active" ? 2 : 1) +
	(r.stale_at === null ? 0.5 : 0) +
	r.confidence;

export const contradictionUnit: Unit = async (ctx, node) => {
	const me = memberOf(ctx, node.id);
	if (!me) return { outcome: "missing" };
	let tokens = 0;
	let flagged = 0;
	let judged = 0;
	for (const p of relatedOf(ctx, node.id, ctx.cfg.related_min)) {
		if (judged >= ctx.cfg.contradiction_pairs) break;
		const other = memberOf(ctx, p.other);
		if (!other) continue;
		const [a, b] = me.node.id < other.node.id ? [me, other] : [other, me];
		const sig = sha(`${a.node.hash ?? ""}\0${b.node.hash ?? ""}`);
		const prior = ctx.db
			.query(
				"SELECT sig FROM distill_pairs WHERE a = ? AND b = ? AND job = 'contradiction'",
			)
			.get(a.node.id, b.node.id) as { sig: string } | null;
		if (prior?.sig === sig) continue;
		ctx.spend.check();
		const res = await ctx.clients.chat.complete(
			CONTRADICTION_SYSTEM,
			`${render(a, 0)}\n\n${render(b, 1)}`,
			300,
		);
		tokens += res.tokens;
		ctx.spend.add(res.tokens);
		judged++;
		const v = ContradictionVerdictSchema.safeParse(jsonObject(res.content));
		const verdict =
			v.success && v.data.contradicts
				? "contradicts"
				: v.success
					? "consistent"
					: "unparsed";
		ctx.db
			.query(
				"INSERT INTO distill_pairs (a, b, job, sig, verdict, at) VALUES (?, ?, 'contradiction', ?, ?, ?) ON CONFLICT (a, b, job) DO UPDATE SET sig = excluded.sig, verdict = excluded.verdict, at = excluded.at",
			)
			.run(a.node.id, b.node.id, sig, verdict, ctx.now());
		if (verdict !== "contradicts" || !v.success) continue;
		upsertEdge(ctx.db, {
			src: a.node.id,
			dst: b.node.id,
			type: "contradicts",
			weight: p.weight,
			evidenceRef: v.data.reason.slice(0, 300),
			createdBy: `contradiction:${ctx.clients.chat.model}`,
			state: "candidate",
		});
		const weaker = rankOf(a.row) <= rankOf(b.row) ? a : b;
		const stronger = weaker === a ? b : a;
		if (
			ctx.sink.propose({
				knowledgeId: weaker.row.id,
				kind: "distill-contradiction",
				score: p.weight,
				reason:
					`contradicts #${String(stronger.row.id)}: ${v.data.reason}`.slice(
						0,
						500,
					),
				payload: { a: a.row.id, b: b.row.id, reason: v.data.reason },
			})
		)
			flagged++;
	}
	return {
		outcome: `judged:${String(judged)} flagged:${String(flagged)}`,
		tokens,
	};
};

/** Land a Kev-cleared draft: candidate row, its node, derived_from edges. */
async function landDraft(
	ctx: JobContext,
	sig: string,
	draft: { topic: string; fact: string; confidence: number },
	members: Member[],
): Promise<number> {
	const refs = members.flatMap((m) => [
		`knowledge:${String(m.row.id)}`,
		...(m.row.source_ref ? [m.row.source_ref] : []),
	]);
	const id = await ctx.sink.upsertCandidate({
		topic: draft.topic,
		fact: draft.fact,
		confidence: Math.min(draft.confidence, 0.6),
		originKind: "distilled",
		sourceRef: null,
		provenance: {
			source_refs: refs,
			by: "distill",
			model: ctx.clients.chat.model,
		},
	});
	const now = ctx.now();
	ctx.db.transaction(() => {
		const nid = upsertNode(
			ctx.db,
			{
				kind: "entry",
				key: `knowledge:${String(id)}`,
				label: draft.topic,
				ref: `knowledge:${String(id)}`,
				hash: sha(`${draft.topic}\0${draft.fact}\0`),
				props: { kstate: "candidate", origin_kind: "distilled" },
			},
			now,
		);
		for (const m of members)
			upsertEdge(
				ctx.db,
				{
					src: nid,
					dst: m.node.id,
					type: "derived_from",
					evidenceRef: `knowledge:${String(m.row.id)}`,
					createdBy: "distill",
					state: "active",
				},
				now,
			);
		ctx.db
			.query(
				"INSERT INTO distill_clusters (sig, state, knowledge_id, draft, at) VALUES (?, 'stored', ?, NULL, ?) ON CONFLICT (sig) DO UPDATE SET state = 'stored', knowledge_id = excluded.knowledge_id, draft = NULL, at = excluded.at",
			)
			.run(sig, id, now);
	})();
	return id;
}

const setCluster = (
	ctx: JobContext,
	sig: string,
	state: string,
	draft: unknown,
): void => {
	ctx.db
		.query(
			"INSERT INTO distill_clusters (sig, state, knowledge_id, draft, at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT (sig) DO UPDATE SET state = excluded.state, draft = excluded.draft, at = excluded.at",
		)
		.run(sig, state, draft === null ? null : JSON.stringify(draft), ctx.now());
};

export const distillUnit: Unit = async (ctx, node) => {
	const me = memberOf(ctx, node.id);
	if (!me) return { outcome: "missing" };
	if (me.row.origin_kind === "distilled") return { outcome: "skip:distilled" };
	const c = ctx.cfg;
	const members: Member[] = [me];
	for (const p of relatedOf(ctx, node.id, c.cluster_min)) {
		if (members.length >= c.cluster_size_max) break;
		const m = memberOf(ctx, p.other);
		if (m && m.row.origin_kind !== "distilled") members.push(m);
	}
	if (members.length < c.cluster_size_min) return { outcome: "cluster:small" };
	members.sort((x, y) => x.node.id - y.node.id);
	const sig = sha(
		members.map((m) => `${String(m.node.id)}:${m.node.hash ?? ""}`).join("|"),
	);
	const prior = ctx.db
		.query("SELECT state, draft FROM distill_clusters WHERE sig = ?")
		.get(sig) as { state: string; draft: string | null } | null;
	if (prior && prior.state !== "pending-kev")
		return { outcome: `cluster:${prior.state}` };
	let tokens = 0;
	let draft: { topic: string; fact: string; confidence: number } | null = null;
	if (prior?.draft) draft = JSON.parse(prior.draft) as typeof draft;
	else {
		ctx.spend.check();
		const res = await ctx.clients.chat.complete(
			DISTILL_SYSTEM,
			members.map(render).join("\n\n"),
			700,
		);
		tokens = res.tokens;
		ctx.spend.add(res.tokens);
		const parsed = DistilledLessonSchema.safeParse(jsonObject(res.content));
		if (!parsed.success || "skip" in parsed.data) {
			setCluster(ctx, sig, parsed.success ? "skipped" : "unparsed", null);
			return {
				outcome: parsed.success ? "model:skip" : "model:unparsed",
				tokens,
			};
		}
		const d = parsed.data as {
			topic: string;
			fact: string;
			confidence?: number;
		};
		draft = { topic: d.topic, fact: d.fact, confidence: d.confidence ?? 0.5 };
	}
	if (!draft) return { outcome: "draft:missing", tokens };
	const kev = await ctx.sink.kev({
		kind: "capsule",
		title: draft.topic,
		text: `${draft.fact}\n\nsources: ${members.map((m) => `#${String(m.row.id)}`).join(", ")}`,
		reference: `distill:${sig.slice(0, 16)}`,
	});
	if (kev.choice === "noise") {
		setCluster(ctx, sig, "noise", null);
		return { outcome: "kev:noise", tokens };
	}
	if (kev.choice === "unavailable") {
		// keep the draft: the next visit re-asks Kev without spending tokens
		setCluster(ctx, sig, "pending-kev", draft);
		return { outcome: "kev:unavailable", tokens };
	}
	const id = await landDraft(ctx, sig, draft, members);
	return { outcome: `distilled:${String(id)}`, tokens };
};
