// hooks/lib/knowledge/distill-clients.ts — payload → candidate JSON distill clients
// (W91 #9): strict parse + canon clamps, the LocalLlm and Buckle adapters,
// and the daemon-startup switch. Split from knowledge-ports.ts (W1255.3);
// the prompt policy in ./prompt-policy.ts, the store port in
// ./store-schema.ts, the SQLite adapter in ./sqlite-store.ts.

import { knowledgeBuckleRoute } from "./knowledge-buckle.ts";
import { LifecycleInference } from "./knowledge-inference.ts";
import { activePrompt } from "./prompt-policy.ts";
export interface DistillClient {
	distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<
		{
			topic: string;
			fact: string;
			confidence: number;
			domain: string | null;
			area: string | null;
			originKind: string | null;
			originSystem: string | null;
			supersedesId: number | null;
		}[]
	>;
}
// ─── distill support: strict JSON parse + canon clamps (#7) ───
export interface DistillItem {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	supersedesId: number | null;
	sourceRef: string | null;
}

// tolerate fences/prose around the JSON array; validate + clamp each item
export function parseDistill(raw: string): DistillItem[] {
	let t = raw.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence) t = fence[1];
	const l = t.indexOf("[");
	const r = t.lastIndexOf("]");
	if (l === -1 || r <= l)
		throw new Error(`no JSON array in distill output: ${t.slice(0, 80)}`);
	const arr = JSON.parse(t.slice(l, r + 1)) as unknown[];
	return arr
		.map(asItem)
		.filter((x): x is DistillItem => x !== null)
		.slice(0, 12);
}

// W91 #9/#7: canon clamps — the distill contract caps topic/fact; raw source
// text never enters the table (source_ref + source_hash point back instead)
function asItem(x: unknown): DistillItem | null {
	if (!x || typeof x !== "object") return null;
	const o = x as Record<string, unknown>;
	const t = typeof o.topic === "string" ? o.topic.trim() : "";
	const f = typeof o.fact === "string" ? o.fact.trim() : "";
	if (!t || !f) return null;
	const s = (v: unknown): string | null =>
		typeof v === "string" && v.trim() ? v.trim() : null;
	const conf =
		typeof o.confidence === "number" && Number.isFinite(o.confidence)
			? Math.min(1, Math.max(0, o.confidence))
			: 0.5;
	return {
		topic: t.slice(0, 80),
		fact: f.slice(0, 400),
		confidence: conf,
		domain: s(o.domain),
		area: s(o.area),
		originKind: s(o.origin_kind)?.toLowerCase() ?? null,
		originSystem: s(o.origin_system),
		// extraction only: the source must DECLARE the correction; the model
		// never judges. Clamped to a real row at insert (store.upsert).
		supersedesId:
			typeof o.supersedes_id === "number" && Number.isInteger(o.supersedes_id)
				? o.supersedes_id
				: null,
		// W103 substitution contract: the model may emit a POINTER ref for
		// doc-covered facts; the worker only honors it when the file resolves
		sourceRef: s(o.source_ref),
	};
}
async function defaultModel(url: string, key?: string): Promise<string> {
	try {
		const r = await fetch(url.replace(/\/chat\/completions$/, "/models"), {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		const j = (await r.json()) as { data?: { id: string }[] };
		return j.data?.[0]?.id ?? "local";
	} catch {
		return "local";
	}
}
// W91 #9: explicit adapter retained for direct unit use. The production
// factory below rejects its legacy endpoint override so inference enters Buckle.
export class LocalLlmDistillClient implements DistillClient {
	constructor(
		private url: string,
		private key?: string,
	) {}

	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const model =
			process.env.INGEST_LLM_MODEL ?? (await defaultModel(this.url, this.key));
		const hintsLine = [
			hints.domain ? `domain=${hints.domain}` : "domain=null",
			hints.area ? `area=${hints.area}` : "area=null",
			hints.codeOrigin ? `code_origin=${hints.codeOrigin}` : "code_origin=null",
		].join(", ");
		return this.chat(payload, hintsLine, model, hints.originSid);
	}

	private async chat(
		payload: string,
		hintsLine: string,
		model: string,
		originSid: string | null,
	): Promise<DistillItem[]> {
		const sys = activePrompt();
		const user = `payload:\n${payload}\n\nenqueue hints (authoritative over your guesses when set): ${hintsLine}${originSid ? `\norigin_sid: ${originSid}` : ""}`;
		const r = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: user },
				],
				temperature: 0.2,
				max_tokens: 1600,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (!r.ok)
			throw new Error(
				`LLM ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
			);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return parseDistill(j.choices?.[0]?.message?.content ?? "");
	}
}
export class BuckleDistillClient implements DistillClient {
	// W1229: distill rides the ONE lifecycle transport — scoped bksk_ key,
	// explicit budget admission, W3C traceparent (route_audit trace_id join),
	// the W96 hint and local-swarm group unchanged.
	#inf = new LifecycleInference();

	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const sys = activePrompt();
		const user = `payload:\n${payload}\n\nenqueue hints: domain=${hints.domain ?? "null"}, area=${hints.area ?? "null"}, code_origin=${hints.codeOrigin ?? "null"}`;
		const out = await this.#inf.chat({
			kind: "distill",
			hint: "prefer local distill reasoning",
			maxTokens: 1600,
			system: sys,
			user,
		});
		return parseDistill(out.content);
	}
}
export function makeDistillClient(): DistillClient {
	if (process.env.INGEST_LLM_URL)
		throw new Error(
			"INGEST_LLM_URL bypasses Buckle; configure SUSPENDERS_BUCKLE_URL and scoped SUSPENDERS_BUCKLE_TOKEN instead",
		);
	// Fail before the worker claims queue rows if its proxy credential is absent.
	knowledgeBuckleRoute();
	return new BuckleDistillClient();
}
