// scripts/lib/validation-cmd.ts — W645 stack-detect validation commands
// (oh-my-claude research L5): the brief's verify demand becomes concrete by
// injecting the target repo's OWN commands, read from qlty + package
// metadata. Config-over-code: a metadata source that exists contributes its
// command, absent sources contribute nothing, no per-ecosystem strings are
// hardcoded — a repo with neither qlty nor scripts gets no line at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The qlty fmt+check pair, run on the files the lane changed — the same
 *  shape the on-write gate runs. `<files>` is the lane's changed-path set. */
const qltyCommands = (repo: string): string[] =>
	existsSync(join(repo, ".qlty", "qlty.toml"))
		? [
				"qlty fmt --no-upgrade-check <files>",
				"qlty check --no-upgrade-check <files>",
			]
		: [];

/** package.json scripts that name verification work, in doctrine order
 *  (typecheck → lint → test). Only scripts that EXIST are injected — the
 *  repo names its own commands; we never invent one. */
const SCRIPT_PRIORITY = ["typecheck", "lint", "test"] as const;

const packageCommands = (repo: string): string[] => {
	const path = join(repo, "package.json");
	if (!existsSync(path)) return [];
	try {
		const pkg = JSON.parse(readFileSync(path, "utf8")) as {
			scripts?: Record<string, string>;
		};
		const scripts = pkg.scripts ?? {};
		return SCRIPT_PRIORITY.filter((s) => typeof scripts[s] === "string").map(
			(s) => `bun run ${s}`,
		);
	} catch {
		return [];
	}
};

/** The repo's validation command line, or null when no metadata source
 *  applies. Pure detection over the repo dir — no defaults, no guessing. */
export const validationCommand = (repo: string): string | null => {
	const cmds = [...qltyCommands(repo), ...packageCommands(repo)];
	return cmds.length > 0 ? cmds.join(" && ") : null;
};
