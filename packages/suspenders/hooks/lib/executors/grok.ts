// hooks/lib/executors/grok.ts — the grok CLI adapter (W422 law: one file
// per agent). Catalog row: grok rides the claude-style arg grammar in
// fleet-loop's direct-launch mode; no dispatch-core spawn recipe yet.
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

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
	// W422.21 direct-launch rows: rides the claude-grammar recipe today;
	// still refused by the spawnable row until a binary probe verifies it.
	wireDialect: "grok",
	workspace: "git-worktree",
	privateGitStore: false,
	identityProtocol: true,
	coordBootstrap: true,
	launchArgs: ({ prompt }) => ["-p", prompt],
	initWorkspaceGit: null,
};
