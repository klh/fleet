// scripts/install/install-conf-migrate.ts — W1253 Amendment A: the install step that
// migrates machine fleet config yaml → JSON once. kernel-conf.migrateYamlConf
// does the per-file work (parse the legacy yaml — the ONE yaml-parse leg the
// fleet keeps — write the .json law name 0600 atomically, move the original
// to .yaml.bak); this step maps it over the machine conf set. Idempotent: a
// present .json is "kept", so re-runs and fresh machines are no-ops.
// W2582: the step also cuts machine conf over to settings.json itself
// (install-settings-cutover.ts) — the yaml legs run first, then the stack
// document folds into the per-install settings.json so no install leaves a
// partial settings.json shadowing a fuller stack.json.
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
import { retireBuckleUpstreamsEnv } from "../lib/belt-row-settings.ts";
import type { StepContext, StepResult } from "./install-run.ts";
import { cutOverSettings } from "./install-settings-cutover.ts";

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

/** The launchd env file is not fleet config; W2760 retires the spoke BUCKLE_UPSTREAMS pin
 *  entirely — settings.json owns the chain now, and a lingering pin would
 *  shadow it (a pin always wins). Retires in place; custom vars untouched. */
function reconcileSpokeUpstreamsEnv(home: string): boolean {
	const r = retireBuckleUpstreamsEnv(
		join(home, ".claude", "local-llm", "buckle-spoke.env"),
	);
	if (r.status === "failed") throw new Error(r.note);
	return r.status === "wired";
}

/** W2760: fold the LLM-plane side files (local-llm upstreams.json,
 *  routing-policy.json) into the settings.json law homes. Idempotent — a
 *  section already present in settings.json WINS (the operator moved
 *  deliberately); a side file that is not JSON content is skipped (the
 *  ONE-parser law has no yaml leg). Originals stay on disk, read-only. */
function foldLlmPlaneConf(home: string): {
	folded: string[];
	skipped: string[];
} {
	const llm = join(home, ".claude", "local-llm");
	const settings = join(home, ".config", "klh", "settings.json");
	const sources: Array<[string, "upstreams" | "routing_policy"]> = [
		[join(llm, "upstreams.json"), "upstreams"],
		[join(llm, "routing-policy.json"), "routing_policy"],
	];
	const folded: string[] = [];
	const skipped: string[] = [];
	if (!existsSync(settings)) return { folded, skipped };
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
	} catch {
		return { folded, skipped: sources.map(([p]) => p) };
	}
	let dirty = false;
	for (const [path, section] of sources) {
		if (doc[section] !== undefined) {
			skipped.push(`${section}:settings-holds`);
			continue;
		}
		if (!existsSync(path)) continue;
		let side: unknown;
		try {
			side = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			skipped.push(`${section}:non-json`);
			continue;
		}
		if (!side || typeof side !== "object" || Array.isArray(side)) {
			skipped.push(`${section}:non-object`);
			continue;
		}
		doc[section] = side;
		folded.push(section);
		dirty = true;
	}
	if (dirty) {
		const mode = statSync(settings).mode & 0o777;
		if (mode !== 0o600)
			throw new Error(
				`settings.json must be mode 600 (got ${mode.toString(8)})`,
			);
		const temporary = `${settings}.tmp-${crypto.randomUUID()}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temporary, settings);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}
	return { folded, skipped };
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
	let fold: { folded: string[]; skipped: string[] } = {
		folded: [],
		skipped: [],
	};
	try {
		fold = foldLlmPlaneConf(ctx.home);
	} catch (error) {
		return {
			status: "failed",
			note: `conf migrate failed folding LLM-plane conf into settings.json: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const parts: string[] = [];
	if (migrated.length > 0) parts.push(`migrated ${migrated.join(", ")}`);
	if (kept.length > 0) parts.push(`kept ${kept.length} json`);
	if (absent.length > 0) parts.push(`${absent.length} absent`);
	if (spokeRepointed)
		parts.push("retired BUCKLE_UPSTREAMS from buckle-spoke.env");
	if (fold.folded.length > 0)
		parts.push(`folded ${fold.folded.join(", ")} into settings.json`);
	// W2582: after the yaml legs, cut machine conf over to settings.json —
	// the install owns the cutover (an un-run `coord settings migrate` no
	// longer strands a stack.json the settings file would mask).
	const cutover = cutOverSettings(ctx.home);
	if (cutover.status === "failed")
		return {
			status: "failed",
			note: `conf migrate failed — settings cutover: ${cutover.note}`,
		};
	parts.push(cutover.note);
	return {
		status: "ok",
		note: `W1253 conf migrate: ${parts.join("; ") || "nothing to do"}`,
		detail: `migrated=[${migrated.join(", ")}] kept=[${kept.join(", ")}] absent=[${absent.join(", ")}] folded=[${fold.folded.join(", ")}] skipped=[${fold.skipped.join(", ")}]`,
	};
}
