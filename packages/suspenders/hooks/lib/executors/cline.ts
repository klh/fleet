// hooks/lib/executors/cline.ts — the cline CLI adapter (W422 law: one file
// per agent). Catalog row: cline rides the claude-style arg grammar in
// fleet-loop's direct-launch mode; no dispatch-core spawn recipe yet.
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

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
