// src/copilot-pat.ts — W2868: the Copilot PAT resolver, extracted from
// bin/copilot-seat-proof.ts so every pinned-relay probe shares one source.
// Resolution order: explicit env GITHUB_COPILOT_PAT, then the CENTRAL provider
// profile bound to the same name (stack.json providers). The secret stays
// inside the calling process and is never printed (W1124.8.4 law).
import {
	loadProviderConfig,
	PROVIDER_STACK_PATH,
	profileForEnv,
} from "@klh/speedy/src/provider-config.ts";

export function resolveCopilotPat(): string {
	return (
		process.env.GITHUB_COPILOT_PAT?.trim() ||
		profileForEnv("GITHUB_COPILOT_PAT", loadProviderConfig(PROVIDER_STACK_PATH()))
			?.key ||
		""
	);
}

export const COPILOT_PAT_MISSING_MSG =
	"Copilot PAT: set GITHUB_COPILOT_PAT in the environment or a provider profile (stack.json providers, env: GITHUB_COPILOT_PAT)";
