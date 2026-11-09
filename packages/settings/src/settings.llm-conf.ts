// settings.llm-conf.ts — W2760: the ONE resolution helper for the LLM-plane
// data documents (upstreams + routing policy). Order: explicit path argument
// → mapped env pin (BUCKLE_UPSTREAMS / BELT_POLICY / BUCKLE_POLICY — an
// operator-pinned file always wins, never silently ignored) → the settings.json
// law home (settings.upstreams / settings.routing_policy documents) → the
// legacy local-llm side files, honored read-only (W1253: the .json law name
// first; a legacy .yaml name only while its content is already JSON). Readers
// (buckle src/upstreams.ts+policy.ts, belt bin/router-policy.ts) own the doc
// validation; this module only resolves bytes. settings.json read posture is
// the CALLER's (service = fail closed; hook = last-known-good + defaults).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Doc, getPath } from "./settings.tree.ts";

export interface LlmConfSource {
	/** Where the bytes came from (diagnostics + tests). */
	source:
		| "explicit"
		| `env:${string}`
		| "settings"
		| "legacy-json"
		| "legacy-yaml-json"
		| "none";
	/** JSON text of the winning candidate; null when nothing resolved. */
	text: string | null;
	/** The file the bytes came from; null for the settings.json section. */
	path: string | null;
}

/** The .json twin of a configured path (upstreams.yaml → upstreams.json):
 *  hubctl/install write .json names (W1253), so an env pin still naming the
 *  legacy .yaml resolves the twin when it is on disk. */
export const jsonSiblingOf = (path: string): string =>
	path.replace(/\.ya?ml$/i, ".json");

const jsonBytes = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/** JSON.parse the text, null when it does not parse (a legacy .yaml name
 *  whose content is still YAML is skipped — the ONE parser law). */
const parsedJson = (text: string): Doc | null => {
	try {
		const doc: unknown = JSON.parse(text);
		return doc && typeof doc === "object" && !Array.isArray(doc)
			? (doc as Doc)
			: null;
	} catch {
		return null;
	}
};

/** Read a candidate file as a JSON doc: the law name (or any .json path)
 *  parses; a legacy .yaml name parses only while its content is JSON. */
const jsonCandidate = (path: string): { text: string } | null => {
	const text = jsonBytes(path);
	if (text === null) return null;
	return parsedJson(text) === null ? null : { text };
};

export interface LlmConfEnv {
	BUCKLE_UPSTREAMS?: string;
	BELT_POLICY?: string;
	BUCKLE_POLICY?: string;
	KLH_SETTINGS?: string;
	HOME?: string;
}

/** Local-llm runtime home under the given HOME. */
const llmHomeOf = (env: LlmConfEnv): string =>
	join(env.HOME ?? homedir(), ".claude", "local-llm");

/** The settings.json path under the given env (KLH_SETTINGS wins, tests). */
const settingsFileOf = (env: LlmConfEnv): string =>
	env.KLH_SETTINGS ??
	join(env.HOME ?? homedir(), ".config", "klh", "settings.json");

/** The section out of settings.json, text-ready; null when the file is
 *  absent, malformed, or carries no section (the doc is skipped, never
 *  fatal — a broken settings.json is the reader plane's loud failure). */
const settingsSectionText = (
	env: LlmConfEnv,
	section: "upstreams" | "routing_policy",
): string | null => {
	const file = settingsFileOf(env);
	const doc = parsedJson(jsonBytes(file) ?? "");
	const value = doc ? getPath(doc, section) : undefined;
	if (value === undefined || value === null) return null;
	return JSON.stringify(value);
};

/**
 * Resolve the upstreams override doc (W2760): explicitPath → env pin
 * (BUCKLE_UPSTREAMS) → settings.upstreams → legacy side files (upstreams.json
 * law name, then the legacy upstreams.yaml name read-only while JSON).
 * The settings.json document is the LAW HOME — when it carries the section,
 * the side files are dead weight the install retire step folds in.
 */
export function resolveUpstreamsDoc(
	explicitPath?: string,
	env: LlmConfEnv = process.env,
): LlmConfSource {
	const pinned = explicitPath ?? env.BUCKLE_UPSTREAMS;
	if (pinned) {
		const direct = jsonCandidate(pinned);
		if (direct) return { source: "explicit", text: direct.text, path: pinned };
		const twin = jsonCandidate(jsonSiblingOf(pinned));
		if (twin)
			return {
				source: "explicit",
				text: twin.text,
				path: jsonSiblingOf(pinned),
			};
		// W1123 fail-forward: a CONFIGURED pin that resolves nowhere is the
		// caller's fatal (buckle loadUpstreams throws) — the resolver reports
		// the miss and keeps walking ONLY for diagnosis parity; callers that
		// need fatal treat text===null + a pin as fatal.
	}
	const settingsText = settingsSectionText(env, "upstreams");
	if (settingsText !== null)
		return { source: "settings", text: settingsText, path: null };
	const home = llmHomeOf(env);
	const json = jsonCandidate(join(home, "upstreams.json"));
	if (json)
		return {
			source: "legacy-json",
			text: json.text,
			path: join(home, "upstreams.json"),
		};
	const yaml = jsonCandidate(join(home, "upstreams.yaml"));
	if (yaml)
		return {
			source: "legacy-yaml-json",
			text: yaml.text,
			path: join(home, "upstreams.yaml"),
		};
	return { source: "none", text: null, path: null };
}

/**
 * Resolve the routing-policy doc (W2760): explicitPath → env pins (BELT_POLICY
 * then BUCKLE_POLICY) → settings.routing_policy → the legacy runtime copy
 * (routing-policy.json law name, then the .yaml name read-only while JSON) —
 * the committed default (buckle/routing-policy.json) stays the belt/buckle
 * loaders' own final rung, as before.
 */
export function resolvePolicyDoc(
	explicitPath?: string,
	env: LlmConfEnv = process.env,
): LlmConfSource {
	const pins = [explicitPath, env.BELT_POLICY, env.BUCKLE_POLICY].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	for (const pin of pins) {
		for (const p of [pin, jsonSiblingOf(pin)]) {
			const hit = jsonCandidate(p);
			if (hit) return { source: "explicit", text: hit.text, path: p };
		}
	}
	const settingsText = settingsSectionText(env, "routing_policy");
	if (settingsText !== null)
		return { source: "settings", text: settingsText, path: null };
	const home = llmHomeOf(env);
	const json = jsonCandidate(join(home, "routing-policy.json"));
	if (json)
		return {
			source: "legacy-json",
			text: json.text,
			path: join(home, "routing-policy.json"),
		};
	const yaml = jsonCandidate(join(home, "routing-policy.yaml"));
	if (yaml)
		return {
			source: "legacy-yaml-json",
			text: yaml.text,
			path: join(home, "routing-policy.yaml"),
		};
	return { source: "none", text: null, path: null };
}
