// hooks/lib/capacity/ramp-classify.ts — W1713 wire-side semantics of the
// ramp: who answered (gateway vs provider), what the usage block says, and
// the tiny synthetic tool-capable request bodies. Pure: no I/O, no clock.
import type { OutcomeClass, RampRoute, RampWire, Usage } from "./ramp-types.ts";

export type ToolMode = "force" | "auto" | "none";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;
const emptyUsage = (): Usage => ({
	fresh: 0,
	cached: 0,
	cacheWrite: 0,
	out: 0,
});

/** buckle stamps x-belt-route as single-line JSON; `refusal` names who
 *  refused (buckle | upstream | bridged-upstream | network | cooldown). */
export function refusalOf(routeHeader: string | null): string | null {
	if (routeHeader === null) return null;
	try {
		const j: unknown = JSON.parse(routeHeader);
		return isRecord(j) && typeof j.refusal === "string" ? j.refusal : null;
	} catch {
		return null;
	}
}

const PROVIDER_ORIGINS = new Set(["upstream", "bridged-upstream", "network"]);

/** The throttle taxonomy: a 429 is the PROVIDER's budget unless the gateway's
 *  own governance stamped it; a 503 is the GATEWAY's (admission, deferred,
 *  cooldown) unless the provider origin is stamped. */
export function classifyStatus(o: {
	status: number;
	refusal: string | null;
	code: string | null;
	toolOk: boolean;
	requireTool: boolean;
}): OutcomeClass {
	const { status, refusal, code } = o;
	if (status >= 200 && status < 300)
		return o.requireTool && !o.toolOk ? "no_tool" : "ok";
	if (status === 401 || status === 403) return "auth";
	if (status === 429) {
		const local =
			refusal === "buckle" ||
			code === "rate_limited" ||
			(code?.startsWith("buckle.") ?? false);
		return local ? "local429" : "provider429";
	}
	if (status < 500) return "client4xx";
	const provider = refusal !== null && PROVIDER_ORIGINS.has(refusal);
	if (provider) return "upstream5xx";
	return status === 503 ? "local503" : "local5xx";
}

/** Usage normalised across wires: anthropic input_tokens already EXCLUDES the
 *  cache columns; Responses input_tokens INCLUDES cached_tokens, so fresh is
 *  the difference. toolCalled = a tool_use / function_call item came back. */
export function extractResult(
	wire: RampWire,
	body: unknown,
): { usage: Usage; toolCalled: boolean } {
	if (!isRecord(body)) return { usage: emptyUsage(), toolCalled: false };
	const u = isRecord(body.usage) ? body.usage : {};
	if (wire === "messages") {
		const blocks = Array.isArray(body.content) ? body.content : [];
		return {
			toolCalled: blocks.some((b) => isRecord(b) && b.type === "tool_use"),
			usage: {
				fresh: num(u.input_tokens),
				cached: num(u.cache_read_input_tokens),
				cacheWrite: num(u.cache_creation_input_tokens),
				out: num(u.output_tokens),
			},
		};
	}
	const items = Array.isArray(body.output) ? body.output : [];
	const details = isRecord(u.input_tokens_details)
		? u.input_tokens_details
		: {};
	const cached = num(details.cached_tokens);
	return {
		toolCalled: items.some((i) => isRecord(i) && i.type === "function_call"),
		usage: {
			fresh: Math.max(0, num(u.input_tokens) - cached),
			cached,
			cacheWrite: 0,
			out: num(u.output_tokens),
		},
	};
}

const PROMPT = "Call the ping tool with ok=true. Reply with nothing else.";
const PING_SCHEMA = {
	type: "object",
	properties: { ok: { type: "boolean" } },
	required: ["ok"],
};

/** Approximate stable prefix (~7 tokens per repeat): lets an operator push
 *  the prompt past a provider's minimum cacheable length. */
export const fillerText = (tokens: number): string =>
	tokens > 0
		? "Synthetic capacity probe filler. ".repeat(Math.ceil(tokens / 7))
		: "";

export const requestPath = (wire: RampWire): string =>
	wire === "messages" ? "/v1/messages" : "/v1/responses";

/** One harmless synthetic request: a one-line prompt, a single `ping` tool,
 *  a small output cap. `force` pins the tool call so a 2xx proves the
 *  tool-capable path, not just text completion. */
export function buildBody(
	route: RampRoute,
	o: { toolMode: ToolMode; maxOut: number; prefixTokens: number },
): Record<string, unknown> {
	const filler = fillerText(o.prefixTokens);
	const force = o.toolMode === "force";
	const tools = o.toolMode !== "none";
	if (route.wire === "messages")
		return {
			model: route.model,
			max_tokens: o.maxOut,
			...(filler ? { system: filler } : {}),
			messages: [{ role: "user", content: PROMPT }],
			...(tools
				? {
						tools: [
							{
								name: "ping",
								description: "Liveness ping.",
								input_schema: PING_SCHEMA,
							},
						],
						tool_choice: force
							? { type: "tool", name: "ping" }
							: { type: "auto" },
					}
				: {}),
		};
	return {
		model: route.model,
		max_output_tokens: o.maxOut,
		store: false,
		...(filler ? { instructions: filler } : {}),
		input: PROMPT,
		...(tools
			? {
					tools: [
						{
							type: "function",
							name: "ping",
							description: "Liveness ping.",
							parameters: PING_SCHEMA,
						},
					],
					tool_choice: force ? { type: "function", name: "ping" } : "auto",
				}
			: {}),
	};
}
