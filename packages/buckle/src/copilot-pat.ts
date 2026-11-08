// src/copilot-pat.ts — W695.6.2: the ONE resolver for the GitHub Copilot seat
// PAT. Order: inherited env → the CENTRAL provider profile bound to
// GITHUB_COPILOT_PAT (stack.json providers) → the machine spoke env file
// (~/.claude/local-llm/buckle-spoke.env, mode 600), which is where the live
// spoke actually carries the seat credential. The secret is returned to the
// caller and NEVER logged — callers put it in process.env, never on stdout.
import { readFileSync } from "node:fs";
import {
	loadProviderConfig,
	PROVIDER_STACK_PATH,
	profileForEnv,
} from "@klh/speedy/src/provider-config.ts";

export const PAT_ENV_NAME = "GITHUB_COPILOT_PAT";

/** The machine spoke env file — the documented home of the seat PAT. */
export const spokeEnvPath = (home = process.env.HOME ?? ""): string =>
	`${home}/.claude/local-llm/buckle-spoke.env`;

/** `NAME=value` lookup over env-file text; `=` inside the value survives. */
export function patFromEnvText(text: string, name = PAT_ENV_NAME): string {
	return (
		text
			.split("\n")
			.find((l) => l.startsWith(`${name}=`))
			?.slice(name.length + 1)
			.trim()
			.replace(/^(["'])(.*)\1$/, "$2") ?? ""
	);
}

/** Resolve the seat PAT; "" when no source carries one (callers fail loudly). */
export function resolveCopilotPat(
	opts: {
		env?: Record<string, string | undefined>;
		stackPath?: string;
		envFilePath?: string;
	} = {},
): string {
	const env = opts.env ?? process.env;
	const fromEnv = env[PAT_ENV_NAME]?.trim();
	if (fromEnv) return fromEnv;
	try {
		const profile = profileForEnv(
			PAT_ENV_NAME,
			loadProviderConfig(opts.stackPath ?? PROVIDER_STACK_PATH()),
		);
		if (profile?.key?.trim()) return profile.key.trim();
	} catch {
		// absent/unreadable provider stack — the env-file leg below is next
	}
	try {
		const path = opts.envFilePath ?? spokeEnvPath(env.HOME ?? "");
		return patFromEnvText(readFileSync(path, "utf8"));
	} catch {
		return "";
	}
}
