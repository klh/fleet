// hooks/lib/executors/claude.ts — the claude-code adapter (W422 surface
// consolidation law: executor specifics are overlay rows, one file per
// agent — a claude fix never touches copilot's file, and a new agent is
// one adapter file + one registry row in registry.ts).
import type { ExecutorAdapter } from "../lane.ts";
import { join } from "node:path";

// The tool-permission recipe: lived in hooks/lib/lane.ts as
// DEFAULT_ALLOWED_TOOLS until the adapter registry extracted the seam —
// it is the CLAUDE spawn recipe, so it lives HERE now (lane.ts re-exports
// it as DEFAULT_ALLOWED_TOOLS for existing importers).
// W1121 permission-policy grammar (verified 2026-10-21, code.claude.com/
// docs/en/permissions): compound commands (&& | ;) need EVERY subcommand
// to match; `:*` is only a TRAILING wildcard (the old bare `Bash(diff)`
// was exact-match and rejected `diff a b`); a prefix rule matches the
// command TEXT — absolute-path invocations (/usr/local/bin/qlty) never
// match a canonical-name rule and still prompt, narrowly, never broadly.
// W1124.12 managed worker profile: a lane is a scoped worker, not a full
// agent runtime — explicit empty MCP config + strict flag drops the 60–161
// inherited tools/10 unrelated MCP servers, the built-in tool list is the
// lane closure (Bash for git/bun/work/coord, Read/Edit/Write/Skill). Not
// --bare (hooks stay live) and not --restricted (settings must apply).
// Canonical compact JSON: spawnClaude single-quotes EVERY argv (W1124.12.1),
// so the payload arrives byte-exact regardless of internal whitespace.
export const WORKER_MANAGED_PROFILE = {
	mcpConfig: '{"mcpServers":{}}',
	tools: "Bash,Read,Edit,Write,Skill",
};

/** The managed-worker argv (W1124.12): one recipe for BOTH the spawn tail
 *  and the starter seed turn — the seed must see the same session shape a
 *  forked lane continues in. */
export const workerManagedArgs = (): string[] => [
	"--strict-mcp-config",
	"--mcp-config",
	WORKER_MANAGED_PROFILE.mcpConfig,
	"--tools",
	WORKER_MANAGED_PROFILE.tools,
];

export const CLAUDE_ALLOWED_TOOLS = [
	// VCS + the runtime (git hooks, bun test, bun splices).
	"Bash(git:*)",
	"Bash(bun:*)",
	// Quality + fast file tools (the lane sandbox's own prefix set).
	"Bash(qlty:*)",
	"Bash(rg:*)",
	"Bash(eza:*)",
	"Bash(ls:*)",
	"Bash(mkdir:*)",
	"Bash(sd:*)",
	"Bash(sed:*)",
	// Prefix, not the old bare exact rule that rejected `diff a b`.
	"Bash(diff:*)",
	// A lane reaches a minted worktree only via compound `cd <tree> && <cmd>`
	// (the audit's composite cd+test wall) — cd matches nothing else, every
	// tail subcommand still needs its own grant.
	"Bash(cd:*)",
	// Read-only stream helpers lanes chain into pipelines.
	"Bash(head:*)",
	"Bash(tail:*)",
	"Bash(wc:*)",
	"Bash(stat:*)",
	"Bash(find:*)",
	"Bash(grep:*)",
	"Bash(cat:*)",
	// W1121: the governed closure verbs — work graph, coord plane, named
	// review tool. Their mutations stay under the governor's own
	// claim/token/worktree checks (lane CLIs, W643; PreToolUse gates run).
	"Bash(work:*)",
	"Bash(coord:*)",
	"Bash(oracle:*)",
	"Edit",
	"Write",
].join(" ");

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
		...workerManagedArgs(),
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
	// W1124.12: the seed rides the SAME managed profile as the spawn tail —
	// a fork continues a session shaped like the one it will run in.
	starterSeedArgs: (seed) => [
		...workerManagedArgs(),
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
