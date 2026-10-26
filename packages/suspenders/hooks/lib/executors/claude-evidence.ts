// hooks/lib/executors/claude-evidence.ts — W1731: the claude-code transcript
// evidence reader (claudeAdapter.evidence, design.client-adapter-dispatch).
// W917 origin gate: run output comes ONLY from results of test invocations
// the session's own assistant initiated (tool_use id pairing + the paired
// command must BE a test run). Counts relayed from other sessions — WS
// inbox dumps and task notifications — pair to nothing this session
// called, so they never count. Assembled from parts so this file's own
// source never trips the W511 scan.
import {
	assemble,
	type EvidenceNormalizer,
	partText,
} from "../gates/claim-evidence.ts";

const TEST_CMD_RE = new RegExp(
	assemble(
		"\\b(?:bun|npm|yarn|pnpm)\\s+(?:run\\s+)?(?:--?[a-z-]+\\s+)*",
		"test\\b|\\bvitest\\b|\\bjest\\b|\\bnode\\s+--test\\b|\\bcargo\\s+",
		"test\\b|\\bgo\\s+test\\b|\\bpytest\\b",
	),
	"i",
);

type ContentPart = {
	type?: unknown;
	text?: unknown;
	content?: unknown;
	id?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
};

const toolResultText = (c: ContentPart): string => {
	if (typeof c.content === "string") return c.content;
	if (!Array.isArray(c.content)) return "";
	return c.content.map(partText).join("\n");
};

export const claudeEvidence: EvidenceNormalizer = () => {
	// tool_use id → did this session's own assistant ask for a test run?
	// Only results of such calls are run output; the rest is foreign noise.
	const initiated = new Map<string, boolean>();
	return (line, ts, sink) => {
		const msg = line.message as
			| { role?: unknown; content?: unknown }
			| undefined;
		const assistant = msg?.role === "assistant" || line.type === "assistant";
		const content = msg?.content;
		let paired = false;
		// sweep 1: register the assistant's own tool_use ids and whether each
		// command WAS a test invocation.
		if (Array.isArray(content) && assistant)
			for (const c of content as ContentPart[]) {
				if (!c || typeof c !== "object") continue;
				if (c.type !== "tool_use") continue;
				const id = typeof c.id === "string" ? c.id : "";
				const cmd = (c.input as { command?: unknown } | undefined)?.command;
				initiated.set(id, typeof cmd === "string" && TEST_CMD_RE.test(cmd));
			}
		if (Array.isArray(content))
			for (const c of content as ContentPart[]) {
				if (!c || typeof c !== "object") continue;
				if (c.type === "tool_result") {
					const id = typeof c.tool_use_id === "string" ? c.tool_use_id : "";
					if (!id || !initiated.get(id)) continue; // foreign: drop
					paired = true;
					const t = toolResultText(c);
					if (t) sink.output(ts, t);
				} else if (assistant && c.type === "text" && typeof c.text === "string")
					sink.prose(ts, c.text);
			}
		if (!paired) return;
		const tur = line.toolUseResult as unknown;
		if (typeof tur === "string") sink.output(ts, tur);
		else if (tur && typeof tur === "object")
			for (const k of ["stdout", "stderr"] as const) {
				const v = (tur as Record<string, unknown>)[k];
				if (typeof v === "string") sink.output(ts, v);
			}
	};
};
