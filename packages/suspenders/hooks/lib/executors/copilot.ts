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
	// otherwise blocks on a confirmation it can never receive headless);
	// --allow-all-paths matches the other dialects' unsandboxed worktree
	// access. W422.21 folded the former fleet-loop-only delta in here, so
	// dispatch-next and fleet-loop launch copilot identically.
	spawnArgs: () => ["--allow-all-tools", "--allow-all-paths"],
	promptArgs: (prompt) => ["-p", prompt],
	// session fork/resume semantics UNVERIFIED — cold start (lane-starter).
	forkArgs: () => null,
	processNames: ["copilot"],
	// W422.21 direct-launch rows: standard worktree lane; opts.effort rides
	// copilot's --reasoning-effort (W183.1).
	wireDialect: "copilot",
	workspace: "git-worktree",
	privateGitStore: false,
	identityProtocol: true,
	coordBootstrap: true,
	launchArgs: ({ prompt, effort }) => [
		"-p",
		prompt,
		...copilotAdapter.spawnArgs({}),
		...(effort ? ["--reasoning-effort", effort] : []),
	],
	initWorkspaceGit: null,
};
