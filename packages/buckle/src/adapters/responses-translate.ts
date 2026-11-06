// src/adapters/responses-translate.ts — W2583 chat↔Responses wire
// translation. Some providers (GitHub Copilot's gpt/grok/mai rows) serve
// ONLY the Responses wire (supported_endpoints [/responses]; no
// /v1/messages, no chat completions) — a chat-shaped rung can never serve
// them. The transforms are reject-verbose (W426 law): a shape with no
// Responses equivalent makes the rung ineligible, the walk falls to the
// next rung — nothing is mangled mid-wire.
type AnyRec = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Text of a string or pure text-part content; null = no equivalent. */
function textOf(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		const rec = block as AnyRec | null;
		if (rec?.type !== "text" || typeof rec.text !== "string") return null;
		parts.push(rec.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** One message → instruction/input row; false = no Responses equivalent. */
function addMessage(
	m: unknown,
	instructions: string[],
	input: AnyRec[],
): boolean {
	const rec = m as AnyRec | null;
	const role = str(rec?.role);
	if (role === "tool") return false;
	const text = textOf(rec?.content);
	if (text === null) return false;
	if (role === "system") {
		instructions.push(text);
		return true;
	}
	if (role !== "user" && role !== "assistant") return false;
	input.push({
		role,
		content: [
			{ type: role === "assistant" ? "output_text" : "input_text", text },
		],
	});
	return true;
}

/** chat-completions body → Responses body. Rejects (returns null) on
 *  tool/tool messages, non-text content parts, and empty input — the
 *  shapes the Responses wire has no equivalent for at this tier. */
export function chatToResponses(body: AnyRec): AnyRec | null {
	// tools/tool_choice shapes are rejected at this tier: the Responses
	// function-tool shape differs structurally and translating it here would
	// mangle semantics — reject-verbose, the walk skips the rung instead.
	if (body.tools !== undefined || body.tool_choice !== undefined) return null;
	if (!Array.isArray(body.messages)) return null;
	const instructions: string[] = [];
	const input: AnyRec[] = [];
	for (const m of body.messages)
		if (!addMessage(m, instructions, input)) return null;
	if (input.length === 0) return null;
	const out: AnyRec = { model: body.model, input };
	if (instructions.length > 0) out.instructions = instructions.join("\n\n");
	const max = body.max_tokens ?? body.max_completion_tokens;
	if (typeof max === "number") out.max_output_tokens = max;
	for (const k of ["temperature", "top_p", "stream"] as const)
		if (body[k] !== undefined) out[k] = body[k];
	return out;
}

/** Text of a Responses output array (concatenated message output_text). */
function outputTextOf(output: unknown): string {
	if (!Array.isArray(output)) return "";
	const parts: string[] = [];
	for (const item of output) {
		const rec = item as AnyRec | null;
		if (rec?.type !== "message") continue;
		const content = rec.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const p = part as AnyRec | null;
			if (p?.type === "output_text" && typeof p.text === "string")
				parts.push(p.text);
		}
	}
	return parts.join("");
}

/** Responses reply object → chat-completions reply (one choice). */
export function responsesToChatJson(wire: AnyRec): AnyRec {
	if (wire.error !== undefined) return { error: wire.error };
	const status = str(wire.status);
	const usage = (wire.usage ?? {}) as AnyRec;
	return {
		id: str(wire.id),
		object: "chat.completion",
		created: num(wire.created_at) || Math.floor(Date.now() / 1000),
		model: str(wire.model),
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: outputTextOf(wire.output) },
				finish_reason: status === "incomplete" ? "length" : "stop",
			},
		],
		usage: {
			prompt_tokens: num(usage.input_tokens),
			completion_tokens: num(usage.output_tokens),
			total_tokens: num(usage.total_tokens),
		},
	};
}
