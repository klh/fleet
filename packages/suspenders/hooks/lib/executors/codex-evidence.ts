// hooks/lib/executors/codex-evidence.ts — W1731: the codex rollout
// transcript evidence reader (codexAdapter.evidence,
// design.client-adapter-dispatch). Run output comes only from the result of
// an own functions.exec call whose script directly invokes one test
// command; assistant output_text is the prose.
import { type EvidenceNormalizer, partText } from "../gates/claim-evidence.ts";

const DIRECT_TEST_START =
	/^(?:bun|npm|yarn|pnpm)\s+(?:run\s+)?test\b|^(?:vitest|jest|pytest)\b|^node\s+--test\b|^cargo\s+test\b|^go\s+test\b/i;

/** The Codex functions.exec script must directly invoke one test command.
 * A relayed inbox message or a script that merely mentions "bun test" is
 * not execution evidence. Reject shell chaining and computed commands. */
const codexInitiatedTest = (source: string): boolean => {
	const calls = [
		...source.matchAll(
			/tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*")/g,
		),
	];
	if (calls.length !== 1) return false;
	let command: string;
	try {
		command = JSON.parse(calls[0]?.[1] ?? "") as string;
	} catch {
		return false;
	}
	return DIRECT_TEST_START.test(command.trim()) && !/[;&|`]/.test(command);
};

export const codexEvidence: EvidenceNormalizer = () => {
	// call_id → was this own exec call a direct test invocation?
	const initiated = new Map<string, boolean>();
	return (line, ts, sink) => {
		const payload = line.payload as Record<string, unknown> | undefined;
		if (line.type !== "response_item" || !payload) return;
		if (payload.type === "custom_tool_call" && payload.name === "exec") {
			const id = payload.call_id;
			if (typeof id === "string")
				initiated.set(
					id,
					typeof payload.input === "string" &&
						codexInitiatedTest(payload.input),
				);
		} else if (payload.type === "custom_tool_call_output") {
			const id = payload.call_id;
			if (typeof id !== "string" || !initiated.get(id)) return;
			if (!Array.isArray(payload.output)) return;
			const content = payload.output.map(partText).join("\n");
			if (content.includes("Script completed")) sink.output(ts, content);
		} else if (payload.type === "message" && payload.role === "assistant") {
			if (!Array.isArray(payload.content)) return;
			for (const part of payload.content as { type?: unknown }[])
				if (part?.type === "output_text") {
					const text = partText(part);
					if (text) sink.prose(ts, text);
				}
		}
	};
};
