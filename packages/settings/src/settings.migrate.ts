// settings.migrate.ts — build settings.json from the legacy sources: the
// stack.json document (version, hub profiles, fleet_loop, providers…), the
// hubs.json candidate registry (merged under the SAME label), and the
// mapped env knobs actually set in the machine's env files / launchd plists.
// Pure: the caller (CLI / install migrateConf) does the I/O. Inline secret
// values found on the way (hub tokens, provider keys) are LIFTED into
// `secrets` (path → content) for 0600 files; the document only ever holds
// their paths. An existing settings.json wins over migrated values.
import { coerceEnv, ENV_BY_NAME } from "./settings.env-map.ts";
import { fromLegacyProfile } from "./settings.project.ts";
import { validateDoc } from "./settings.reader.ts";
import {
	type Doc,
	deepMerge,
	getPath,
	isPlainObject,
	setPath,
} from "./settings.tree.ts";

export interface MigrateInput {
	stack?: Doc | null;
	hubsRegistry?: Doc | null;
	/** dotenv / env-file texts (NAME=value lines). */
	envTexts?: string[];
	/** launchd plist XML texts (EnvironmentVariables dicts). */
	plistTexts?: string[];
	existing?: Doc | null;
	/** Directory the lifted 0600 secret files go in. */
	secretsDir: string;
}

export interface MigrateResult {
	doc: Doc;
	secrets: Record<string, string>;
	report: string[];
	issues: string[];
}

const STACK_COPY = [
	"version",
	"updates",
	"auth",
	"executors",
	"policies",
	"postures",
	"cache_unsupported_models",
	"fleet_loop",
] as const;

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_");

function migrateProviders(
	providers: Doc,
	secretsDir: string,
	out: MigrateResult,
): Doc {
	const res: Doc = {};
	for (const [name, raw] of Object.entries(providers)) {
		if (!isPlainObject(raw)) continue;
		const { key, ...rest } = raw;
		if (typeof key === "string" && key) {
			const varName =
				typeof rest.key_name === "string"
					? rest.key_name
					: `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
			const file = `${secretsDir}/provider-${slug(name)}.env`;
			out.secrets[file] = `${varName}=${key}\n`;
			rest.key_file = file;
			rest.key_name = varName;
			out.report.push(`providers.${name}: inline key lifted to ${file} (0600)`);
		}
		res[name] = rest;
	}
	return res;
}

function migrateHubs(input: MigrateInput, out: MigrateResult): Doc {
	const hubs: Doc = {};
	const profiles = isPlainObject(input.stack?.hubs)
		? (input.stack?.hubs as Doc)
		: {};
	for (const [label, raw] of Object.entries(profiles)) {
		if (!isPlainObject(raw)) continue;
		const conv = fromLegacyProfile(raw);
		if (conv.secrets.token) {
			const file = `${input.secretsDir}/hub-${slug(label)}.token`;
			out.secrets[file] = `${conv.secrets.token}\n`;
			conv.hub.token_file = file;
			out.report.push(`hubs.${label}: inline token lifted to ${file} (0600)`);
		}
		hubs[label] = conv.hub;
	}
	for (const [label, raw] of Object.entries(input.hubsRegistry ?? {})) {
		if (!isPlainObject(raw)) continue;
		const hub: Doc = isPlainObject(hubs[label]) ? (hubs[label] as Doc) : {};
		const cands = Array.isArray(raw.candidates)
			? raw.candidates.filter((c): c is string => typeof c === "string")
			: [];
		const prior = Array.isArray(hub.candidates)
			? (hub.candidates as string[])
			: [];
		if (cands.length) hub.candidates = [...new Set([...prior, ...cands])];
		if (typeof raw.token === "string" && raw.token && !hub.token_file) {
			const file = `${input.secretsDir}/hub-${slug(label)}.token`;
			out.secrets[file] = `${raw.token}\n`;
			hub.token_file = file;
			out.report.push(
				`hubs.${label}: hubs.json token lifted to ${file} (0600)`,
			);
		}
		hubs[label] = hub;
		out.report.push(
			`hubs.${label}: merged ${cands.length} hubs.json candidate(s)`,
		);
	}
	return hubs;
}

/** NAME=value pairs from env-file texts and plist EnvironmentVariables. */
export function envPairs(input: MigrateInput): Map<string, string> {
	const pairs = new Map<string, string>();
	for (const text of input.envTexts ?? [])
		for (const line of text.split("\n")) {
			const mm = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
				line,
			);
			if (mm?.[1] && mm[2] !== undefined)
				pairs.set(mm[1], mm[2].replace(/^(['"])(.*)\1$/, "$2"));
		}
	const kv = /<key>([A-Z][A-Z0-9_]*)<\/key>\s*<string>([^<]*)<\/string>/g;
	for (const text of input.plistTexts ?? [])
		for (const mm of text.matchAll(kv))
			if (mm[1] && mm[2] !== undefined) pairs.set(mm[1], mm[2]);
	return pairs;
}

export function migrate(input: MigrateInput): MigrateResult {
	const out: MigrateResult = { doc: {}, secrets: {}, report: [], issues: [] };
	let doc: Doc = {};
	const stack = input.stack ?? {};
	for (const key of STACK_COPY)
		if (stack[key] !== undefined) doc[key] = structuredClone(stack[key]);
	if (isPlainObject(stack.providers))
		doc.providers = migrateProviders(stack.providers, input.secretsDir, out);
	const known = new Set<string>([...STACK_COPY, "providers", "hubs"]);
	for (const key of Object.keys(stack))
		if (!known.has(key))
			out.issues.push(`stack.json ${key}: no settings section — not migrated`);
	doc.hubs = migrateHubs(input, out);
	for (const [name, raw] of envPairs(input)) {
		const map = ENV_BY_NAME.get(name);
		if (!map || getPath(doc, map.path) !== undefined) continue;
		const value = coerceEnv(map, raw);
		if (value === undefined) {
			out.report.push(`env ${name}=${raw}: not a valid ${map.kind}, skipped`);
			continue;
		}
		doc = setPath(doc, map.path, value);
		out.report.push(`env ${name} → ${map.path}`);
	}
	if (input.existing) doc = deepMerge(doc, input.existing) as Doc;
	doc.$schema = "./settings.schema.json";
	const check = validateDoc(doc);
	if (!check.ok) out.issues.push(...check.issues);
	out.doc = doc;
	return out;
}
