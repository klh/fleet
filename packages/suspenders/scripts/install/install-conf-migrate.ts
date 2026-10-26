// scripts/install/install-conf-migrate.ts — W1253 Amendment A: the install step that
// migrates machine fleet config yaml → JSON once. kernel-conf.migrateYamlConf
// does the per-file work (parse the legacy yaml — the ONE yaml-parse leg the
// fleet keeps — write the .json law name 0600 atomically, move the original
// to .yaml.bak); this step maps it over the machine conf set. Idempotent: a
// present .json is "kept", so re-runs and fresh machines are no-ops.
import {
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { migrateYamlConf } from "../../hooks/lib/kernel-conf.ts";
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

/** The launchd env file is not fleet config, but its explicit path must
 * follow the upstreams file moved by this step. Leave custom paths alone. */
function reconcileSpokeUpstreamsEnv(home: string): boolean {
	const llm = join(home, ".claude", "local-llm");
	const env = join(llm, "buckle-spoke.env");
	const yaml = join(llm, "upstreams.yaml");
	const json = join(llm, "upstreams.json");
	if (!existsSync(env) || !existsSync(json)) return false;
	const prefix = "BUCKLE_UPSTREAMS=";
	let changed = false;
	const updated = readFileSync(env, "utf8")
		.split("\n")
		.map((line) => {
			if (!line.startsWith(prefix)) return line;
			const raw = line.slice(prefix.length);
			const quote = raw[0] === "'" || raw[0] === '"' ? raw[0] : "";
			const value = quote && raw.endsWith(quote) ? raw.slice(1, -1) : raw;
			if (value !== yaml) return line;
			changed = true;
			return `${prefix}${quote}${json}${quote}`;
		})
		.join("\n");
	if (!changed) return false;
	const mode = statSync(env).mode & 0o777;
	if (mode !== 0o600)
		throw new Error(
			`buckle-spoke.env must be mode 600 (got ${mode.toString(8)})`,
		);
	const temporary = `${env}.tmp-${crypto.randomUUID()}`;
	try {
		writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
		renameSync(temporary, env);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
	return true;
}

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
	let spokeRepointed = false;
	try {
		spokeRepointed = reconcileSpokeUpstreamsEnv(ctx.home);
	} catch (error) {
		return {
			status: "failed",
			note: `conf migrate failed for buckle-spoke.env: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const parts: string[] = [];
	if (migrated.length > 0) parts.push(`migrated ${migrated.join(", ")}`);
	if (kept.length > 0) parts.push(`kept ${kept.length} json`);
	if (absent.length > 0) parts.push(`${absent.length} absent`);
	if (spokeRepointed) parts.push("repointed buckle-spoke.env");
	return {
		status: "ok",
		note: `W1253 conf migrate: ${parts.join("; ") || "nothing to do"}`,
		detail: `migrated=[${migrated.join(", ")}] kept=[${kept.join(", ")}] absent=[${absent.join(", ")}]`,
	};
}
