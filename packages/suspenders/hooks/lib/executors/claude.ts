// hooks/lib/executors/claude.ts — the claude-code adapter (W422 surface
// consolidation law: executor specifics are overlay rows, one file per
// agent — a claude fix never touches copilot's file, and a new agent is
// one adapter file + one registry row in registry.ts).
import type { ExecutorAdapter } from "../../../scripts/lib/lane.ts";
import { join } from "node:path";

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
	managedRuntime: {
		entrypoint: join(import.meta.dir, "..", "..", "bin", "claude-runtime.ts"),
		nativeBinEnv: "SUSPENDERS_CLAUDE_NATIVE_BIN",
	},
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
	// W918.3: the one-turn starter seed argv — the only harness whose seed
	// turn is probe-verified (W454/W768). lane-starter keys the seed on this.
	starterSeedArgs: (seed) => [
		"-p",
		seed,
		"--output-format",
		"json",
		"--max-turns",
		"1",
	],
	processNames: ["claude", "claude-runtime.ts"],
	// W626: launchd's bare PATH hides the native install — which() misses and
	// every versioned claude row degraded to the unknown compatibility branch.
	installPaths: ["~/.local/bin/claude"],
};
