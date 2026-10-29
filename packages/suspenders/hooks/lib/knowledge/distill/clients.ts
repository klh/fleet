// distill/clients.ts — the distiller's three model legs, each a port so the
// e2e suite drives serveStub upstreams:
//   embed   → the :8907 embeddings specialist (batched; LifecycleInference)
//   rerank  → the :8913 rerank specialist (optional; cosine when absent)
//   chat    → buckle ONLY, on the knowledge worker's scoped bksk_ key, model
//             = the configured model group (never a direct provider key).
// Every response body is safeParse'd through a named schema (Schema law).
// A non-2xx or malformed answer throws UpstreamBusy for 408/429/503/504 so
// the runner STOPS the job (never competes with lanes) instead of retrying.
import { z } from "zod";
import { knowledgeBuckleRoute } from "../knowledge-buckle.ts";
import {
	LifecycleInference,
	lifecycleTraceparent,
	memoryLimits,
} from "../knowledge-inference.ts";
import type { DistillConfig } from "./config.ts";

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface Embedder {
	embed(texts: string[]): Promise<number[][]>;
}
export interface Reranker {
	/** relevance score per document, in document order */
	rerank(query: string, docs: string[]): Promise<number[]>;
}
export interface ChatResult {
	content: string;
	tokens: number;
}
export interface Chat {
	readonly model: string;
	complete(
		system: string,
		user: string,
		maxTokens: number,
	): Promise<ChatResult>;
}
export interface DistillClients {
	embed: Embedder;
	rerank: Reranker | null;
	chat: Chat;
}

/** The upstream said "not now" — stop this job for the run, retry later. */
export class UpstreamBusy extends Error {}

const BUSY = new Set([408, 429, 503, 504]);

async function failure(leg: string, r: Response): Promise<Error> {
	const body = (await r.text().catch(() => "")).slice(0, 200);
	const msg = `${leg} ${String(r.status)}: ${body}`;
	return BUSY.has(r.status) ? new UpstreamBusy(msg) : new Error(msg);
}

export const RerankResponseSchema = z
	.object({
		results: z.array(
			z
				.object({
					index: z.number().int().min(0),
					relevance_score: z.number(),
				})
				.loose(),
		),
	})
	.loose();

export const ChatResponseSchema = z
	.object({
		choices: z
			.array(
				z
					.object({
						message: z.object({ content: z.string().nullable() }).loose(),
					})
					.loose(),
			)
			.min(1),
		usage: z
			.object({
				prompt_tokens: z.number().optional(),
				completion_tokens: z.number().optional(),
				total_tokens: z.number().optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

export function rerankClient(
	url: string,
	model: string,
	doFetch: FetchLike = fetch,
): Reranker {
	return {
		async rerank(query, docs) {
			if (!docs.length) return [];
			const r = await doFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model, query, documents: docs }),
				signal: AbortSignal.timeout(60_000),
			});
			if (!r.ok) throw await failure("rerank", r);
			const parsed = RerankResponseSchema.safeParse(await r.json());
			if (!parsed.success)
				throw new Error(`rerank: ${z.prettifyError(parsed.error)}`);
			const out = docs.map(() => 0);
			for (const row of parsed.data.results)
				if (row.index < out.length) out[row.index] = row.relevance_score;
			return out;
		},
	};
}

export function chatClient(
	route: { front: URL; token: string },
	model: string,
	doFetch: FetchLike = fetch,
): Chat {
	return {
		model,
		async complete(system, user, maxTokens) {
			const r = await doFetch(new URL("/v1/chat/completions", route.front), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${route.token}`,
					traceparent: lifecycleTraceparent(),
					"x-belt-hint": "knowledge lifecycle: idle distill",
				},
				body: JSON.stringify({
					model,
					max_tokens: maxTokens,
					temperature: 0.1,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
				}),
				signal: AbortSignal.timeout(300_000),
			});
			if (!r.ok) throw await failure("chat", r);
			const parsed = ChatResponseSchema.safeParse(await r.json());
			if (!parsed.success)
				throw new Error(`chat: ${z.prettifyError(parsed.error)}`);
			const u = parsed.data.usage;
			return {
				content: parsed.data.choices[0]?.message.content ?? "",
				tokens:
					u?.total_tokens ??
					(u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0),
			};
		},
	};
}

export function embedClient(
	c: DistillConfig,
	doFetch: FetchLike = fetch,
): Embedder {
	const inf = new LifecycleInference({
		limits: {
			...memoryLimits(),
			embedUrl: c.embed_url,
			embedModel: c.embed_model,
		},
		fetch: doFetch,
	});
	return { embed: (texts) => inf.embed(texts) };
}

/** Production legs: embeddings + rerank from config, chat via buckle. */
export function productionClients(c: DistillConfig): DistillClients {
	return {
		embed: embedClient(c),
		rerank: c.rerank_url ? rerankClient(c.rerank_url, c.rerank_model) : null,
		chat: chatClient(knowledgeBuckleRoute(), c.model_group),
	};
}

/** Tolerant JSON-object extraction (fences / prose around the object). */
export function jsonObject(raw: string): unknown {
	let t = raw.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence?.[1]) t = fence[1];
	const l = t.indexOf("{");
	const r = t.lastIndexOf("}");
	if (l === -1 || r <= l) return null;
	try {
		return JSON.parse(t.slice(l, r + 1));
	} catch {
		return null;
	}
}
