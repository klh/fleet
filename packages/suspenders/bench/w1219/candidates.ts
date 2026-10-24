// bench/w1219/candidates.ts — the three translator candidates, one call
// face each. Latency = full round-trip per question (what /knowledge/query
// would feel). The cloud leg rides the buckle front with a scoped per-bench
// bksk_ key (minted by the runner, revoked after).
export interface Candidate {
	name: string;
	kind: string;
	/** one completion round-trip; latency measured by the runner around this */
	call(prompt: string): Promise<string>;
}

const TIMEOUT_MS = 120_000;

/** NAS Ollama sqlcoder — /api/generate, template passthrough. */
export function ollamaCandidate(url: string, model: string): Candidate {
	return {
		name: `${model}@nas-ollama`,
		kind: "local-nas",
		call: async (prompt) => {
			const r = await fetch(`${url}/api/generate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					prompt,
					stream: false,
					options: { temperature: 0 },
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`ollama ${r.status}`);
			const d = (await r.json()) as { response?: string };
			if (typeof d.response !== "string")
				throw new Error("ollama: no response");
			return d.response;
		},
	};
}

/** Swarm extract specialist (:8902-class) — OpenAI wire. */
export function openaiCandidate(
	url: string,
	model: string,
	name: string,
): Candidate {
	return {
		name,
		kind: "local-swarm",
		call: async (prompt) => {
			const r = await fetch(`${url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: prompt }],
					temperature: 0,
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`openai-wire ${r.status}`);
			const d = (await r.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const c = d.choices?.[0]?.message?.content;
			if (typeof c !== "string") throw new Error("openai-wire: no content");
			return c;
		},
	};
}

/** Cloud small fallback — buckle front, Anthropic wire, scoped bksk_ key. */
export function anthropicCandidate(
	url: string,
	model: string,
	name: string,
	apiKey: string,
): Candidate {
	return {
		name,
		kind: "cloud",
		call: async (prompt) => {
			const r = await fetch(`${url}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					// thinking headroom — a thinking model that exhausts the budget
					// emits zero text blocks (the 512 run measured the budget)
					max_tokens: 2048,
					messages: [{ role: "user", content: prompt }],
					temperature: 0,
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!r.ok) throw new Error(`anthropic-wire ${r.status}`);
			const d = (await r.json()) as {
				content?: { type?: string; text?: string }[];
			};
			const t = (d.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (!t) throw new Error("anthropic-wire: no text");
			return t;
		},
	};
}
