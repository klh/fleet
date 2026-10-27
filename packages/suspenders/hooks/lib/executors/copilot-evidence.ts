// hooks/lib/executors/copilot-evidence.ts — W1731: the native Copilot
// events.jsonl evidence reader (copilotAdapter.evidence,
// design.client-adapter-dispatch). The W1357 CopilotTestEvidence pairing
// owns run validity: a timestamped own test bash request and its terminal
// result (directly or through an own shellId-linked read_bash
// continuation); failed terminal results supersede earlier passes.
import type { EvidenceNormalizer } from "../gates/claim-evidence.ts";
import { CopilotTestEvidence } from "../gates/copilot-test-evidence.ts";

export const copilotEvidence: EvidenceNormalizer = () => {
	const copilot = new CopilotTestEvidence();
	return (line, ts, sink) => {
		if (
			line.type !== "assistant.message" &&
			line.type !== "tool.execution_complete"
		)
			return;
		const data = line.data as Record<string, unknown> | undefined;
		if (ts <= 0 || !data || typeof data !== "object") return;
		if (line.type === "tool.execution_complete") {
			const run = copilot.complete(data, ts);
			if (run) sink.output(run.ts, run.text);
			return;
		}
		if (typeof data.content === "string") sink.prose(ts, data.content);
		if (Array.isArray(data.toolRequests))
			for (const request of data.toolRequests)
				if (request && typeof request === "object")
					copilot.request(request as Record<string, unknown>, ts);
	};
};
