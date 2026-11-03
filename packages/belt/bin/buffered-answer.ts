// buffered-answer.ts — W2417.1 B2 extraction (W1238.6 stop rule: the
// router-shim band is shrink-only). One home for the buffered-answer tail:
// the answer a ladder leg produced (local text, local OpenAI tool calls,
// or escalated gate tool_use blocks) rendered onto BOTH faces — the
// buffered JSON message and the SSE stream a stream:true client asked for.
// The stop_reason law lives HERE, once: tool blocks present ⇒ tool_use;
// otherwise the gate's own stop_reason, else stopReason(finish).
import type {
	AnthropicToolUse,
	OpenAiToolCall,
	UpstreamUsage,
} from "./router-core.ts";
import { anthropicSseFromBlocks, stopReason, usageRow } from "./router-core.ts";
import { parseToolArgs } from "./router-tools.ts";

/** The buffered answer one ladder leg produced — exactly what the two
 *  response faces render. */
export interface BufferedAnswer {
	/** The leg's text (already trimmed/joined upstream). */
	text: string | undefined;
	/** W789: local-ladder OpenAI-wire tool calls. */
	localToolCalls?: OpenAiToolCall[];
	/** W2182: escalation-leg tool_use blocks (anthropic shape). */
	escalatedToolUses?: AnthropicToolUse[];
	/** W2182: the answering leg's usage; escalation beats local. */
	usage?: UpstreamUsage;
	/** W2417.1 B2: the gate answer's own stop_reason. */
	stopReason?: string;
	/** The local leg's finish_reason (stop/length/tool_calls). */
	finish?: string;
}

/** The W2182 blocks row both faces share: text first, tool blocks after. */
export function bufferedBlocks(
	a: BufferedAnswer,
): Array<{ type: "text"; text: string } | AnthropicToolUse> {
	return [
		...(a.text ? [{ type: "text", text: a.text }] : []),
		...(a.escalatedToolUses ?? []),
	];
}

/** The buffered JSON face's content row: text + local tool calls
 *  (translated) + escalated tool blocks. */
export function bufferedContent(
	a: BufferedAnswer,
): Array<Record<string, unknown>> {
	return [
		...(a.text ? [{ type: "text", text: a.text }] : []),
		...(a.localToolCalls ?? []).map((c) => ({
			type: "tool_use",
			id: c.id,
			name: c.function.name,
			input: parseToolArgs(c.function.arguments),
		})),
		...(a.escalatedToolUses ?? []),
	];
}

/** One stop_reason for both faces: tool blocks ⇒ tool_use; else the gate's
 *  own stop_reason (W2417.1 B2); else stopReason(finish). */
export function bufferedStopReason(a: BufferedAnswer): string {
	const hasTools =
		(a.localToolCalls && a.localToolCalls.length > 0) ||
		(a.escalatedToolUses && a.escalatedToolUses.length > 0);
	if (hasTools) return "tool_use";
	return a.stopReason ?? stopReason(a.finish);
}

/** The stream face: the shared blocks row as an Anthropic SSE wire. */
export function bufferedStream(
	a: BufferedAnswer,
	meta: Parameters<typeof anthropicSseFromBlocks>[1],
): ReadableStream<Uint8Array> {
	return anthropicSseFromBlocks(
		bufferedBlocks(a),
		meta,
		a.finish,
		a.usage,
		// sawTool inside the translator already forces tool_use; the gate's
		// own stop_reason rides the text-only tail.
		a.stopReason,
	);
}

/** The JSON face's usage row (honest zeros when no leg reported). */
export const bufferedUsageRow = (a: BufferedAnswer) => usageRow(a.usage);
