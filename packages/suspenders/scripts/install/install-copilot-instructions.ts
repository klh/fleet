// scripts/install/install-copilot-instructions.ts — the Copilot CLI global
// instructions face (W2563). Copilot CLI 1.0.105 loads global instructions
// ONLY from ~/.copilot/copilot-instructions.md (or
// ~/.copilot/instructions/**/*.instructions.md) — NOT
// ~/.copilot/instructions.md (verified live 2026-11-02, sessions
// #101489/#101492; lesson.copilot-cli-instructions-filename). The fleet
// coordinator workflow never injected on the old path. Per the owner
// correction (#101810), this file is a POINTER file only:
//   1. an existing copilot-instructions.md is user content — preserved
//      untouched (idempotent re-runs never rewrite it);
//   2. ~/.copilot/instructions.md is NEVER moved, renamed or rewritten —
//      it stays byte-untouched (the canonical fleet instruction set lives
//      there; other tooling may consume that filename);
//   3. an absent loaded path gets a short pointer file (mode 0644) whose
//      content directs the AI to read and follow ~/.copilot/instructions.md
//      — one source of truth, loaded via the path Copilot CLI actually reads.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The pointer a fresh/absent loaded path gets — short, and it points at
 *  the canonical ~/.copilot/instructions.md, never copies it. */
export const COPILOT_GLOBAL_INSTRUCTIONS = `# Fleet global instructions (pointer)

Copilot CLI loads global instructions from this file ONLY — it never reads
the canonical \`instructions.md\`. So: read and follow
\`~/.copilot/instructions.md\` in full before any task; it is the ONE fleet
instruction set. This pointer is fleet-install managed and written only
when absent; it never overwrites or moves \`instructions.md\`.
`;

export interface CopilotInstructionsResult {
	/** ok = the loaded path now holds the pointer (existing/fresh). */
	status: "ok" | "planned";
	/** How the loaded path got its content on this run. */
	source: "existing" | "fresh" | "none";
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
	writeFileSync(loaded, COPILOT_GLOBAL_INSTRUCTIONS, { mode: 0o644 });
	return {
		status: "ok",
		source: "fresh",
		note: `wrote pointer ${loaded} → ~/.copilot/instructions.md (canonical, untouched)`,
	};
}
