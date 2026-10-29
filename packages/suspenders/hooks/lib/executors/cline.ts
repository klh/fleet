// hooks/lib/executors/cline.ts — the cline CLI adapter (W422 law: one file
// per agent). Honest record (W929.2): the wire dialect ships
// (hooks/dialects/cline/, W296) but the cline CLI is not installed here and
// the adapter has never run a lane — no verified spawn recipe, no
// Buckle-front proof; catalog rows stay spawnable=false/buckle=unknown
// until a real install + e2e lane proof.
import type { ExecutorAdapter } from "../../lane.ts";

export const clineAdapter: ExecutorAdapter = {
	id: "cline",
	names: ["cline"],
	bin: "cline",
	// resolveLaneExecutor refuses cline today (same gate as grok).
	spawnable: false,
	briefHarness: "claude",
	briefHardGate: false,
	// catalog-only: no verified spawn recipe in dispatch core
	spawnArgs: () => [],
	promptArgs: (prompt) => ["-p", prompt],
	forkArgs: () => null,
	processNames: ["cline"],
};
