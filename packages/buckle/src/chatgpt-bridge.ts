// Native ChatGPT Responses fallback: the installed LiteLLM converter extracts
// only a contiguous leading string SYSTEM run into instructions. Developer
// messages retain their role in input and end that extraction prefix. Any
// later/non-string system remains a system input item, which the backend
// refuses. With no other input, all-system instructions also become such an
// item (the native empty-input fallback).
//
// Normalize pure text blocks only while retaining message role and order.
// Unsupported order/content typed-refuses this rung before fetch; the next
// rung receives the untouched request. Never fold, demote or drop instructions.
type AnyRec = Record<string, unknown>;

export type ChatgptInstructionPlan =
	| { kind: "passthrough" }
	| { kind: "normalize"; messages: unknown[]; flattened: number }
	| {
			kind: "refuse";
			reason:
				| "mid-turn-instruction"
				| "non-text-instruction-content"
				| "system-after-developer"
				| "system-only-input";
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
	let hasNativeInput = false;
	let flattened = 0;
	let changed = false;
	for (const message of messages) {
		const rec = message as AnyRec | null;
		if (!isInstructionRole(rec?.role)) {
			sawTurn = true;
			hasNativeInput = true;
			out.push(rec);
			continue;
		}
		if (sawTurn) return { kind: "refuse", reason: "mid-turn-instruction" };
		if (rec.role === "system" && hasNativeInput)
			return { kind: "refuse", reason: "system-after-developer" };
		if (rec.role === "developer") hasNativeInput = true;
		const text = textOfContent(rec.content);
		if (text === null)
			return { kind: "refuse", reason: "non-text-instruction-content" };
		if (Array.isArray(rec.content)) {
			flattened++;
			changed = true;
			out.push({ ...rec, content: text });
		} else out.push(rec);
	}
	if (messages.length > 0 && !hasNativeInput)
		return { kind: "refuse", reason: "system-only-input" };
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
