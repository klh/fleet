// helpers/prompt-phase-fixture.ts — W863 phase-map fixtures for
// prompt-transform-phases.e2e.ts (spec files stay annotation-free).
import type {
	ContextPhase,
	preparePrompt,
} from "../../hooks/board/prompt-transform.ts";

type PrepareDeps = Parameters<typeof preparePrompt>[2];

/** preparePrompt deps: enhance unreachable, two disclosed injections. */
export function phaseDeps(): PrepareDeps {
	return {
		enhance: async (t: string) => ({
			text: t,
			ok: false,
			note: "enhance skipped: router unreachable",
			model: "m",
			ms: 1,
		}),
		injections: [
			{ label: "system prompt", text: "SYS" },
			{ label: "repo context", text: "\n\nREPO CONTEXT:\nctx-é" },
		],
	};
}

/** A ready repo-law phase whose text carries a redactable secret. */
export function repoLawPhase(): ContextPhase {
	return {
		id: "repo-law",
		label: "repo law",
		source: "worktree files",
		state: "ready",
		bytes: 20,
		tokens: 5,
		cacheable: "yes",
		note: null,
		text: "token: abcdefgh12345",
	};
}
