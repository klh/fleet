// hooks/lib/executors/forge.ts — the ForgeCode CLI adapter (W422 law: one
// file per agent). Catalog row for the W915 carrier bench's third plaid
// candidate: facts doc-verified against the antinomyhq/forge README
// 2026-10-19 (binary `forge`, non-interactive `-p <PROMPT>`, BYOK via the
// OpenAI-compatible provider env) — NO binary probe yet, the forge seat
// install is owner-gated. resolveLaneExecutor refuses forge today (same
// gate as grok/cline) until the seat lands and the spawn recipe is probed.
import type { ExecutorAdapter } from "../lane.ts";

export const forgeAdapter: ExecutorAdapter = {
	id: "forge",
	names: ["forge", "forgecode"],
	bin: "forge",
	spawnable: false,
	briefHarness: "claude",
	briefHardGate: false,
	// catalog-only: no verified spawn recipe in dispatch core
	spawnArgs: () => [],
	promptArgs: (prompt) => ["-p", prompt],
	forkArgs: () => null,
	processNames: ["forge"],
};
