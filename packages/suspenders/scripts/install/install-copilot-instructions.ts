// scripts/install/install-copilot-instructions.ts — the Copilot CLI global
// instructions face (W2563). Copilot CLI 1.0.105 loads global instructions
// ONLY from ~/.copilot/copilot-instructions.md (or
// ~/.copilot/instructions/**/*.instructions.md) — NOT
// ~/.copilot/instructions.md (verified live 2026-11-02, sessions
// #101489/#101492; lesson.copilot-cli-instructions-filename). The fleet
// coordinator workflow never injected on the old path, so this writer lands
// the pointer block on the LOADED path:
//   1. an existing copilot-instructions.md is user content — preserved
//      untouched (idempotent re-runs never rewrite it);
//   2. a legacy ~/.copilot/instructions.md migrates over (rename) when the
//      loaded path is absent;
//   3. a fresh machine gets the fleet pointer block (mode 0644).
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The pointer block a fresh machine gets — fleet doctrine lives in the
 *  global CLAUDE.md; this file only needs to make a Copilot session find it. */
export const COPILOT_GLOBAL_INSTRUCTIONS = `# Fleet global instructions

This machine runs the klh agent fleet. Every session on it:

- Global doctrine: \`~/.claude/CLAUDE.md\` is the ONE global doctrine — read it
  at session start; the repo's \`AGENTS.md\` chain carries package law and
  overrides per repo.
- Work graph: claims, coordination and reporting ride the \`work\`, \`coord\`
  and \`dispatch\` CLIs — the graph is the ONE ledger, never Markdown todos.
- Quality: \`qlty fmt\` + \`qlty check\` on changed files; evidence before
  assertions — run the check, paste the output, then claim the result.
- Secrets are minted, never typed; machine conf (\`~/.config/klh/stack.json\`,
  \`~/.claude/local-llm/*.env\`) is mode 600 and never committed.

Managed by fleet-install: it writes this file ONLY when absent (your edits
are preserved); the legacy \`instructions.md\` path is NOT loaded by Copilot
CLI — this \`copilot-instructions.md\` path is.
`;

export interface CopilotInstructionsResult {
	/** ok = the loaded path now holds instructions (existing/migrated/fresh). */
	status: "ok" | "planned";
	/** How the loaded path got its content on this run. */
	source: "existing" | "migrated" | "fresh" | "none";
	note: string;
}

export function installCopilotInstructions(
	options: {
		home?: string;
		copilotHome?: string;
		dryRun?: boolean;
	} = {},
): CopilotInstructionsResult {
	const home = options.home ?? process.env.HOME ?? "";
	const copilotHome =
		options.copilotHome ??
		process.env.COPILOT_HOME ??
		join(home, ".copilot");
	const loaded = join(copilotHome, "copilot-instructions.md");
	if (existsSync(loaded)) {
		return {
			status: "ok",
			source: "existing",
			note: `${loaded} already present — preserved`,
		};
	}
	if (options.dryRun) {
		return {
			status: "planned",
			source: "none",
			note: `would write ${loaded} (dry-run — nothing touched)`,
		};
	}
	mkdirSync(copilotHome, { recursive: true });
	const legacy = join(copilotHome, "instructions.md");
	if (existsSync(legacy)) {
		renameSync(legacy, loaded);
		return {
			status: "ok",
			source: "migrated",
			note: `migrated instructions.md → copilot-instructions.md (the loaded path)`,
		};
	}
	writeFileSync(loaded, COPILOT_GLOBAL_INSTRUCTIONS, { mode: 0o644 });
	return {
		status: "ok",
		source: "fresh",
		note: `wrote ${loaded} (the Copilot CLI loaded path)`,
	};
}
