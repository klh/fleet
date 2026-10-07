// hooks/lib/executors/claude.ts — the claude-code adapter (W422 surface
// consolidation law: executor specifics are overlay rows, one file per
// agent — a claude fix never touches copilot's file, and a new agent is
// one adapter file + one registry row in registry.ts).
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";

// The tool-permission recipe: lived in scripts/lib/lane.ts as
// DEFAULT_ALLOWED_TOOLS until the adapter registry extracted the seam —
// it is the CLAUDE spawn recipe, so it lives HERE now (lane.ts re-exports
// it as DEFAULT_ALLOWED_TOOLS for existing importers).
export const CLAUDE_ALLOWED_TOOLS =
	"Bash(git:*) Bash(bun:*) Bash(qlty:*) Bash(rg:*) Bash(eza:*) Bash(ls:*) Bash(mkdir:*) Bash(sd:*) Bash(sed:*) Bash(diff) Edit Write";

export const claudeAdapter: ExecutorAdapter = {
	id: "claude",
	names: ["claude"],
	bin: "claude",
	spawnable: true,
	// W223.2: no observed claude brief mangling — warn-only verification.
	briefHarness: "claude",
	briefHardGate: false,
	spawnArgs: ({
		allowedTools,
		fallbackModels = [],
		settingsArgs = [],
		forkArgs = [],
	}) => [
		"--allowedTools",
		allowedTools ?? CLAUDE_ALLOWED_TOOLS,
		"--permission-mode",
		"acceptEdits",
		// same-bin chain tail rides claude's native --fallback-model (W183.2)
		...(fallbackModels.length > 0
			? ["--fallback-model", fallbackModels.join(",")]
			: []),
		...settingsArgs,
		...forkArgs,
	],
	promptArgs: (prompt) => ["-p", prompt],
	// W454 starter-session fork — binary-verified on the installed executor.
	forkArgs: (sessionId) => ["--resume", sessionId, "--fork-session"],
	processNames: ["claude"],
};
