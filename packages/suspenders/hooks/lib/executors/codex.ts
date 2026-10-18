// hooks/lib/executors/codex.ts — the codex CLI adapter (W422 law: one file
// per agent; facts verified W73/W296 + live 2026-10-18 probes on the 0.158
// binary: `exec --json` emits thread.started (thread_id) + turn.completed
// (usage split); `exec fork <id> [PROMPT]` starts a NEW thread from the
// parent history, parent untouched; `-s` is refused after `fork` — the
// sandbox rides config (-c overrides) on forked lines).
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
	// W808: the full spawn line is adapter-owned — head carries the exec
	// subcommand + starter-fork placement, the prompt is POSITIONAL (prompt
	// LAST is codex's grammar; `-p` is --profile here, not a prompt flag).
	headArgs: ({ forkArgs = [] }) => [
		"--sandbox",
		"danger-full-access",
		"exec",
		...forkArgs,
	],
	promptArgs: (prompt) => [prompt],
	// `exec fork <id>` verified live on 0.158 (W808): each fork takes a NEW
	// thread id and leaves the parent thread intact — the exact W454 fork
	// contract. Relative to the exec subcommand (headArgs owns placement).
	forkArgs: (sessionId) => ["fork", sessionId],
	// W808: the seed turn rides `exec --json` so the thread id + usage land
	// in JSONL; read-only sandbox — a seed answers text, it never writes.
	seedArgs: (seed) => ["exec", "--json", "-s", "read-only", seed],
	processNames: ["codex"],
};
