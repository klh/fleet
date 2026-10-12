// hooks/lib/executors/codex.ts — the codex CLI adapter (W422 law: one file
// per agent; facts verified W73/W296 + the 0.158 binary probes).
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

export const codexAdapter: ExecutorAdapter = {
	id: "codex",
	names: ["codex"],
	bin: "codex",
	spawnable: true,
	// No observed codex brief mangling — warn-only (verifyBrief has no codex
	// profile yet; adding one = one brief-verify row, zero core branches).
	briefHarness: "claude",
	briefHardGate: false,
	// The codex spawn recipe is fleet-loop's (`exec` subcommand, prompt LAST)
	// — cataloged here for the fleet-loop registry conversion; dispatch core
	// never spawns codex via spawnClaude.
	spawnArgs: () => ["--sandbox", "danger-full-access"],
	promptArgs: (prompt) => ["exec", prompt],
	// `exec resume <id>` chaining verified on the 0.158 binary (W454 probe);
	// wiring waits on the spawn-recipe composition (module header, W454).
	forkArgs: () => null,
	// seatbelt workspaces + AGENTS.md sandbox facts live in the codex dialect
	// (hooks/dialects/codex/) until fleet-loop rides the registry.
	processNames: ["codex"],
};
