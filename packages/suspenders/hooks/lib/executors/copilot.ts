// hooks/lib/executors/copilot.ts — the copilot CLI adapter (W422 law: one
// file per agent; specifics verified live in W223/W223.1).
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

export const copilotAdapter: ExecutorAdapter = {
	id: "copilot",
	names: ["copilot"],
	bin: "copilot",
	spawnable: true,
	// W223.2: copilot's prompt layer mangles control bytes/oversized briefs —
	// a failing brief REFUSES the dispatch (claude runs warn-only).
	briefHarness: "copilot",
	briefHardGate: true,
	// W223.1: --allow-all-tools is REQUIRED for non-interactive mode (copilot
	// otherwise blocks on a confirmation it can never receive headless).
	// dispatch-next's recipe is the bare flag; fleet-loop adds
	// --allow-all-paths — that delta is fleet-loop's conversion to carry.
	spawnArgs: () => ["--allow-all-tools"],
	promptArgs: (prompt) => ["-p", prompt],
	// session fork/resume semantics UNVERIFIED — cold start (lane-starter).
	forkArgs: () => null,
	processNames: ["copilot"],
};
