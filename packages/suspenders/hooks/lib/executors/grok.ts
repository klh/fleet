// hooks/lib/executors/grok.ts — the grok CLI adapter (W422 law: one file
// per agent). Honest record (W929.2): the wire dialect ships
// (hooks/dialects/grok/, W296) but the grok CLI is not installed here and
// the adapter has never run a lane — no verified spawn recipe, no
// Buckle-front proof; catalog rows stay spawnable=false/buckle=unknown
// until a real install + e2e lane proof.
import type { ExecutorAdapter } from "../../lane.ts";

export const grokAdapter: ExecutorAdapter = {
	id: "grok",
	names: ["grok"],
	bin: "grok",
	// resolveLaneExecutor refuses grok today (fleet-loop's dispatch gate is
	// claude/codex only) — flipping this is the fleet-loop conversion's call.
	spawnable: false,
	briefHarness: "claude",
	briefHardGate: false,
	// catalog-only: no verified spawn recipe in dispatch core
	spawnArgs: () => [],
	promptArgs: (prompt) => ["-p", prompt],
	forkArgs: () => null,
	processNames: ["grok"],
};
