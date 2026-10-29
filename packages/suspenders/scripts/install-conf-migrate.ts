// scripts/install-conf-migrate.ts — W1253 Amendment A: the install step that
// migrates machine fleet config yaml → JSON once. kernel-conf.migrateYamlConf
// does the per-file work (parse the legacy yaml — the ONE yaml-parse leg the
// fleet keeps — write the .json law name 0600 atomically, move the original
// to .yaml.bak); this step maps it over the machine conf set. Idempotent: a
// present .json is "kept", so re-runs and fresh machines are no-ops.
import { join } from "node:path";
import { migrateYamlConf } from "../hooks/lib/kernel-conf.ts";
import type { StepContext, StepResult } from "./install-run.ts";

/** The machine conf set, as extension-less base paths under the user home.
 *  Hub-side files (upstreams.hub, routing-policy.hub) are NOT here — hubctl
 *  pushes those, and it writes .json names only since W1253. */
export const CONF_BASES = [
	join(".config", "klh", "stack"),
	join(".config", "klh", "notify"),
	join(".config", "klh", "chatgpt-coordinate"),
	join(".claude", "local-llm", "routing-policy"),
	join(".claude", "local-llm", "upstreams"),
	join(".claude", "local-llm", "repo-policy"),
] as const;

export async function migrateConf(ctx: StepContext): Promise<StepResult> {
	if (ctx.dryRun) {
		return {
			status: "ok",
			note: "conf migrate observed (dry-run — no migration performed)",
		};
	}
	const migrated: string[] = [];
	const kept: string[] = [];
	const absent: string[] = [];
	for (const base of CONF_BASES) {
		const root = join(ctx.home, base);
		try {
			const r = migrateYamlConf(`${root}.yaml`, `${root}.json`);
			if (r === "migrated") migrated.push(base);
			else if (r === "kept") kept.push(base);
			else absent.push(base);
		} catch (error) {
			return {
				status: "failed",
				note: `conf migrate failed for ${base}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	const parts: string[] = [];
	if (migrated.length > 0) parts.push(`migrated ${migrated.join(", ")}`);
	if (kept.length > 0) parts.push(`kept ${kept.length} json`);
	if (absent.length > 0) parts.push(`${absent.length} absent`);
	return {
		status: "ok",
		note: `W1253 conf migrate: ${parts.join("; ") || "nothing to do"}`,
		detail: `migrated=[${migrated.join(", ")}] kept=[${kept.join(", ")}] absent=[${absent.join(", ")}]`,
	};
}
