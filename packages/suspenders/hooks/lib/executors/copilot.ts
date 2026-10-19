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
	// W918.3: verified fork args append when the spec carries them.
	spawnArgs: (spec) => ["--allow-all-tools", ...(spec.forkArgs ?? [])],
	promptArgs: (prompt) => ["-p", prompt],
	// Session resume VERIFIED live on the 1.0.98 binary (W918.3, 2026-10-19):
	// two -p turns sharing --session-id <uuid> — turn 2 recalled turn 1's
	// token over the Buckle BYOK route. No --fork-session: a resume appends
	// to the same stored session, so the W622 retake immutability fence
	// cannot hold here (resume-from.ts stays claude-only).
	forkArgs: (sessionId) => ["--session-id", sessionId],
	// W918.3: no starterSeedArgs — the seed turn's claude-grammar flags
	// (--max-turns) die on this CLI; cold start until a copilot seed recipe
	// is probe-verified (fork grammar ≠ seed grammar).
	processNames: ["copilot"],
};
