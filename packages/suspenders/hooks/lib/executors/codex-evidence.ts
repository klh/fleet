import { type EvidenceNormalizer, partText } from "../gates/claim-evidence.ts";
import { evidenceCall, type EvidenceCall } from "./codex-evidence-call.ts";
import { evidenceOutput } from "./codex-evidence-output.ts";
import { evidenceSessions } from "./codex-evidence-sessions.ts";
/** Correlate literal own test calls and their read-only asynchronous completion. */
export const codexEvidence: EvidenceNormalizer = () => {
	const initiated = new Map<string, EvidenceCall | null>();
	const sessions = evidenceSessions();
	return (line, ts, sink) => {
		const payload = line.payload as Record<string, unknown> | undefined;
		if (line.type !== "response_item" || !payload) return;
		if (payload.type === "custom_tool_call" && payload.name === "exec") {
			if (typeof payload.call_id !== "string") return;
			const call =
				typeof payload.input === "string" ? evidenceCall(payload.input) : null;
			initiated.set(payload.call_id, call);
			sessions.begin(call);
		} else if (payload.type === "custom_tool_call_output") {
			const id = payload.call_id;
			if (typeof id !== "string" || !initiated.has(id)) return;
			const call = initiated.get(id) ?? null;
			initiated.delete(id);
			if (!Array.isArray(payload.output)) return;
			sessions.consume(
				call,
				evidenceOutput(payload.output.map(partText).join("\n")),
				ts,
				sink,
			);
		} else if (payload.type === "message" && payload.role === "assistant") {
			if (!Array.isArray(payload.content)) return;
			for (const part of payload.content as { type?: unknown }[]) {
				if (part?.type !== "output_text") continue;
				const text = partText(part);
				if (text) sink.prose(ts, text);
			}
		}
	};
};
