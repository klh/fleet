// mcp-tools.ts — W260: the belt MCP tool surface. Two tools:
//   knowledge_search — ranked retrieval over the fleet knowledge layer
//     (knowledge.db cards + governor.db facts/consult_kb), prose-card output
//     with trust markers so a remote consumer treats hits as leads, not facts.
//   belt_infer — one-shot LLM completion routed through the local belt router
//     (:4000, Anthropic wire). The fleet's routing ladder decides the model.
// Tool EXECUTION failures surface inside the result (isError) per the MCP
// spec; protocol errors (unknown tool) are the server's JSON-RPC problem.
import { searchKnowledge, type KnowledgeCard } from "./mcp-knowledge.ts";

export const SERVER_INFO = { name: "belt-mcp", version: "0.1.0" } as const;

const ROUTER_URL = () => process.env.BELT_ROUTER_URL ?? "http://127.0.0.1:4000";

const FILTER_SCHEMA = {
	domain: {
		type: "string",
		description: "repo/product filter, e.g. belt or suspenders",
	},
	area: { type: "string", description: "subsystem filter, e.g. fleet-loop" },
	origin_kind: {
		type: "string",
		description: "lesson | incident | decision | study | fact",
	},
	origin_system: { type: "string", description: "machine/site filter" },
} as const;

export const TOOLS = [
	{
		name: "knowledge_search",
		description:
			"Search the klh fleet's shared knowledge store (distilled lessons, incidents, decisions, facts, consult answers). Returns prose cards with trust markers (state, age, source ref) — hits are leads to verify against their source, not settled truth. Supports natural-language queries plus optional domain/area/kind/system filters.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"natural-language search, e.g. 'launchd plist wiring' or 'gate race protocol'",
				},
				limit: { type: "number", description: "max hits (default 10, max 50)" },
				...FILTER_SCHEMA,
			},
			required: ["query"],
		},
	},
	{
		name: "belt_infer",
		description:
			"Run a one-shot LLM completion through the klh belt router (complexity-scored local swarm with cloud escalation). Use for drafting, summarizing, or answering a single prompt; the router picks the model. Not a chat session — each call is independent.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "the user prompt" },
				system: { type: "string", description: "optional system prompt" },
				max_tokens: {
					type: "number",
					description: "response budget (default 1024)",
				},
			},
			required: ["prompt"],
		},
	},
] as const;

const cardLine = (c: KnowledgeCard): string => {
	const head =
		c.kind === "knowledge"
			? `knowledge #${c.id} · ${c.state ?? "candidate"} · ${c.ageDays ?? 0}d`
			: c.kind === "fact"
				? `fact ${c.id} · ${c.ageDays ?? 0}d`
				: `consult_kb #${c.id} · ${c.ageDays ?? 0}d`;
	const scope =
		[c.domain, c.area].filter(Boolean).length > 0
			? ` · ${[c.domain, c.area].filter(Boolean).join("/")}`
			: "";
	const ref = c.sourceRef ? ` · ref: ${c.sourceRef}` : "";
	return `[${head}${scope}] ${c.topic ? `${c.topic} — ` : ""}${c.snippet || c.text}${ref}`;
};

async function knowledgeSearch(args: Record<string, unknown>): Promise<string> {
	const query = typeof args.query === "string" ? args.query : "";
	if (!query.trim()) throw new Error("query is required");
	const cards = searchKnowledge(query, {
		limit: typeof args.limit === "number" ? args.limit : 10,
		domain: typeof args.domain === "string" ? args.domain : null,
		area: typeof args.area === "string" ? args.area : null,
		originKind: typeof args.origin_kind === "string" ? args.origin_kind : null,
		originSystem:
			typeof args.origin_system === "string" ? args.origin_system : null,
	});
	if (!cards.length) return `No knowledge-store hits for: ${query}`;
	const lines = cards.map(cardLine);
	return [
		"Fleet knowledge cards (leads — verify against the ref before relying on them):",
		...lines,
	].join("\n");
}

async function beltInfer(
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const prompt = typeof args.prompt === "string" ? args.prompt : "";
	if (!prompt.trim()) throw new Error("prompt is required");
	const body: Record<string, unknown> = {
		model: "belt-router",
		max_tokens: typeof args.max_tokens === "number" ? args.max_tokens : 1024,
		messages: [{ role: "user", content: prompt }],
	};
	if (typeof args.system === "string") body.system = args.system;
	const res = await fetch(`${ROUTER_URL()}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
			: AbortSignal.timeout(120_000),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`belt router ${res.status}: ${detail.slice(0, 200) || "no detail"}`,
		);
	}
	const data = (await res.json()) as {
		content?: { type?: string; text?: string }[];
	};
	const text = (data.content ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
	if (!text) throw new Error("belt router returned no text content");
	return text;
}

export const callTool = async (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> => {
	try {
		if (name === "knowledge_search")
			return { text: await knowledgeSearch(args), isError: false };
		if (name === "belt_infer")
			return { text: await beltInfer(args, signal), isError: false };
		throw new Error(`unknown tool: ${name}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { text: `tool error: ${message}`, isError: true };
	}
};
