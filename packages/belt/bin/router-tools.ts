// router-tools.ts — W761.1: Anthropic tool history → OpenAI messages.
// Split out of router-core (1500-line law); the core ⇄ tools import cycle
// is functions+types only (hoisted, no top-level evaluation).
import {
	blockText,
	type AnthropicBody,
	type ChatMessage,
	type OpenAiToolCall,
} from "./router-core.ts";

export function anthropicMessagesToOpenAi(body: AnthropicBody): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const m of body.messages ?? []) {
		const role: "user" | "assistant" =
			m.role === "assistant" ? "assistant" : "user";
		if (typeof m.content === "string") {
			messages.push({ role, content: m.content });
			continue;
		}
		const blocks = Array.isArray(m.content)
			? (m.content as Array<Record<string, unknown>>)
			: [];
		let text = "";
		const toolCalls: OpenAiToolCall[] = [];
		const results: Array<{ id: string; content: string }> = [];
		for (const b of blocks) {
			const t = b?.type;
			if (t === "text" && typeof b.text === "string") text += b.text;
			else if (
				role === "assistant" &&
				t === "tool_use" &&
				typeof b.name === "string"
			)
				toolCalls.push({
					id: typeof b.id === "string" ? b.id : `call_${toolCalls.length}`,
					type: "function",
					function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
				});
			else if (role === "user" && t === "tool_result")
				results.push({
					id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
					content:
						typeof b.content === "string" ? b.content : blockText(b.content),
				});
		}
		if (role === "assistant" && toolCalls.length > 0)
			messages.push({
				role: "assistant",
				content: text,
				tool_calls: toolCalls,
			});
		else if (role === "user" && results.length > 0) {
			for (const r of results)
				messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
			if (text) messages.push({ role: "user", content: text });
		} else messages.push({ role, content: text });
	}
	return messages;
}

/** tool_use argument JSON → an object (Anthropic input must be one). */
export const parseToolArgs = (args: string): Record<string, unknown> => {
	if (!args) return {};
	try {
		const v = JSON.parse(args) as unknown;
		return typeof v === "object" && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: { value: v };
	} catch {
		return { _raw: args };
	}
};
