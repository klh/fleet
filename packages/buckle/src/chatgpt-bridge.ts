// src/chatgpt-bridge.ts — W1124.27: keep instruction authority through the
// native ChatGPT Responses fallback conversion. LiteLLM's native chatgpt
// bridge maps ONLY leading STRING system/developer content to Responses
// `instructions`; block-valued leading content and mid-turn system/developer
// messages stay `input[].role=system`, which the ChatGPT codex backend
// rejects with 400 {"detail":"System messages are not allowed"} (live-probed
// against chatgpt/gpt-6-sol via :4100, 2026-10-23: leading string 200,
// leading block 400, mid-turn system 400, mid-turn developer 400, leading
// developer 200, tools 200 with a real function_call).
//
// Mapping law (owner correction 2026-10-23): normalize ONLY where the native
// documented semantics are equivalent — a leading run of string/pure-text-
// block instructions keeps role and order and lands in `instructions` either
// way, so flattening pure `type:"text"` blocks to their joined string is
// textual. Everything the native connector has no equivalent for — mid-turn
// instructions (position would change) and non-text instruction content —
// is TYPED-REFUSED: the hop is ineligible, the walk falls to the next rung,
// nothing is mangled and nothing is dropped.
//
// The native connector supports two instruction faces (instructions field,
// plus string leading system/developer that becomes it) and passes tool
// definitions through verbatim. It offers NO system-class input slot — the
// backend refuses developer-in-input too. So mid-turn system/developer text
// cannot keep its turn position natively; folding it into the instructions
// block is the only mapping that never demotes it to user authority and
// never drops it. Turn order of user/assistant/tool messages is untouched.
type AnyRec = Record<string, unknown>;

export type ChatgptInstructionPlan =
	| { kind: "passthrough" }
	| { kind: "normalize"; messages: unknown[]; flattened: number }
	| {
			kind: "refuse";
			reason: "mid-turn-instruction" | "non-text-instruction-content";
	  };

/** Text of a string or pure `type:"text"` block content; null = the native
 *  bridge has no equivalent shape (never flatten blind). */
const textOfContent = (content: unknown): string | null => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		const rec = block as { type?: unknown; text?: unknown } | null;
		if (rec?.type !== "text" || typeof rec.text !== "string") return null;
		parts.push(rec.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
};

const isInstructionRole = (role: unknown): boolean =>
	role === "system" || role === "developer";

/** LiteLLM chatgpt-provider group: the `chatgpt/` prefix is the native
 *  provider route (mode: responses — chat completions bridge to the codex
 *  backend). Group name == wire id; a group without the prefix whose
 *  deployment aliases one still carries it on dep.model. */
export const isChatgptGroupModel = (model: unknown): boolean =>
	typeof model === "string" && model.startsWith("chatgpt/");

export function chatgptInstructionPlan(
	messages: unknown,
): ChatgptInstructionPlan {
	if (!Array.isArray(messages)) return { kind: "passthrough" };
	const out: AnyRec[] = [];
	let sawTurn = false;
	let flattened = 0;
	let changed = false;
	for (const message of messages) {
		const rec = message as AnyRec | null;
		if (!isInstructionRole(rec?.role)) {
			sawTurn = true;
			out.push(rec);
			continue;
		}
		if (sawTurn) return { kind: "refuse", reason: "mid-turn-instruction" };
		const text = textOfContent(rec.content);
		if (text === null)
			return { kind: "refuse", reason: "non-text-instruction-content" };
		if (Array.isArray(rec.content)) {
			flattened++;
			changed = true;
			out.push({ ...rec, content: text });
		} else out.push(rec);
	}
	if (!changed) return { kind: "passthrough" };
	return { kind: "normalize", messages: out, flattened };
}

/** Chat-completions body rewritten toward the chatgpt native bridge, or null
 *  when the body carries a shape the native connector refuses — the hop is
 *  ineligible (skip-not-fail; the ladder falls to the next rung verbatim). */
export function chatgptSafeBody(body: AnyRec): AnyRec | null {
	if (!Array.isArray(body.messages)) return body;
	const plan = chatgptInstructionPlan(body.messages);
	if (plan.kind === "refuse") return null;
	if (plan.kind === "passthrough") return body;
	return { ...body, messages: plan.messages };
}
