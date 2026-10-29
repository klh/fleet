// bin/provider-profiles.ts — belt's contract twin of the central provider
// resolver (packages/speedy/src/provider-config.ts, W1124.8.1). Provider
// profiles live ONLY in the private machine stack.yaml (mode 600): the raw
// operator key is the CENTRAL value; `env` is an OUTPUT binding (the env
// var NAME a gateway materializes at runtime); `endpoints` carries the
// http(s) URL each wire dialect rides. No ambient-env read and no legacy
// key-file fallback HERE — values flow private config → resolved profile →
// materialized runtime binding. This twin exists because the flat runtime
// home (~/.claude/local-llm) is npm-free (Bun.YAML + node builtins only);
// test/provider-profiles.test.ts runs BOTH loaders on the same fixtures so
// the contracts cannot drift.
import { readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderEndpoints {
	/** OpenAI-dialect base (incl. /v1 where the wire needs it). */
	openai?: string;
	/** Anthropic-dialect base. */
	anthropic?: string;
	/** Model catalog snapshot URL (public data — never a credential). */
	catalog?: string;
}

export interface ProviderEntry {
	provider: string;
	key: string;
	env?: string;
	endpoints?: ProviderEndpoints;
}

export interface ResolvedProvider {
	name: string;
	provider: string;
	key: string;
	env: string | null;
	endpoints: ProviderEndpoints;
}

/** Private stack.yaml location — KLH_STACK overrides (tests); `home` pins
 *  the fixture root where the caller already threads one (model-access). */
export const providerStackPath = (home?: string): string =>
	process.env.KLH_STACK ??
	join(home ?? homedir(), ".config", "klh", "stack.yaml");

const MAX_STACK_BYTES = 1024 * 1024;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const ENDPOINT_FIELDS = ["openai", "anthropic", "catalog"] as const;

const isHttpUrl = (v: unknown): v is string => {
	if (typeof v !== "string") return false;
	let url: URL;
	try {
		url = new URL(v);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.hostname.length === 0) return false;
	if (url.username.length > 0 || url.password.length > 0) return false;
	if (url.hash.length > 0) return false;
	return true;
};

function fail(msg: string): never {
	throw new Error(`provider config: ${msg}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate an already-parsed stack's `providers` slice — pure, redacted
 *  errors (profile names only, never values). Same contract as the speedy
 *  validator: family + non-empty key required, env must be an env var
 *  NAME, endpoints must be known http(s) URLs, legacy declarations
 *  (key_file/key_name/base_url) fail pointing at the migration, and two
 *  profiles may not bind the same env name. */
export function validateProviderProfiles(
	input: unknown,
): Record<string, ProviderEntry> {
	if (input === undefined || input === null) return {};
	if (!isRecord(input)) fail("providers must be a map of named profiles");
	const out: Record<string, ProviderEntry> = {};
	const envOwners = new Map<string, string>();
	for (const [name, raw] of Object.entries(input)) {
		if (!isRecord(raw)) fail(`profile ${name} must be a mapping`);
		const row = raw;
		if (typeof row.provider !== "string" || row.provider.trim().length === 0)
			fail(`profile ${name}: provider family is required`);
		if (typeof row.key !== "string" || row.key.trim().length === 0)
			fail(`profile ${name}: key must be a non-empty central value`);
		for (const legacy of ["key_file", "key_name", "base_url"] as const) {
			if (row[legacy] !== undefined)
				fail(
					`profile ${name}: legacy ${legacy} declaration — key is the central value, env is the OUTPUT binding`,
				);
		}
		let env: string | undefined;
		if (row.env !== undefined) {
			if (typeof row.env !== "string" || !ENV_NAME_RE.test(row.env))
				fail(`profile ${name}: env must be an env var NAME (OUTPUT binding)`);
			env = row.env;
		}
		const endpoints: ProviderEndpoints = {};
		if (row.endpoints !== undefined) {
			if (!isRecord(row.endpoints))
				fail(`profile ${name}: endpoints must be a mapping`);
			const eps = row.endpoints;
			for (const field of Object.keys(eps)) {
				if (!(ENDPOINT_FIELDS as readonly string[]).includes(field))
					fail(
						`profile ${name}: endpoints.${field} is not a known endpoint field`,
					);
			}
			for (const field of ENDPOINT_FIELDS) {
				const v = eps[field];
				if (v === undefined) continue;
				if (!isHttpUrl(v))
					fail(`profile ${name}: endpoints.${field} must be an http(s) URL`);
				endpoints[field] = v;
			}
		}
		if (env) {
			const owner = envOwners.get(env);
			if (owner !== undefined)
				fail(`profiles ${owner} and ${name} both bind env ${env}`);
			envOwners.set(env, name);
		}
		out[name] = {
			provider: row.provider,
			key: row.key,
			...(env ? { env } : {}),
			...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
		};
	}
	return out;
}

/** Load + validate the private stack's provider profiles — regular file,
 *  mode 600, ≤1 MiB; no providers section is a valid empty config. */
export function loadProviderProfiles(
	path: string = providerStackPath(),
	read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Record<string, ProviderEntry> {
	let st: Stats;
	try {
		st = statSync(path);
	} catch {
		fail(`stack config not readable at ${path}`);
	}
	if (!st.isFile()) fail(`stack config ${path} must be a regular file`);
	if ((st.mode & 0o777) !== 0o600)
		fail(
			`stack config ${path} must be mode 600 (got ${(st.mode & 0o777).toString(8)})`,
		);
	if (st.size > MAX_STACK_BYTES)
		fail(`stack config ${path} is over the 1 MiB cap`);
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(read(path));
	} catch {
		fail(`stack config ${path} is not parseable YAML`);
	}
	if (parsed !== undefined && parsed !== null && !isRecord(parsed))
		fail(`stack config ${path} must be a YAML mapping`);
	const providers = isRecord(parsed)
		? (parsed as { providers?: unknown }).providers
		: undefined;
	return validateProviderProfiles(providers);
}

/** Resolve one profile by name — absent (optional) → null; configured but
 *  invalid throws (redacted). */
export function resolveProfile(
	name: string,
	profiles: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	const entry = profiles[name];
	if (!entry) return null;
	const p = validateProviderProfiles({ [name]: entry })[name];
	return {
		name,
		provider: p.provider,
		key: p.key,
		env: p.env ?? null,
		endpoints: p.endpoints ?? {},
	};
}

/** The profile whose OUTPUT binding names `env` — the explicit env-binding
 *  lookup every gateway key injection rides (env name first, never a path
 *  convention). First declaration wins; the validator already refuses a
 *  second profile binding the same env. */
export function profileForEnv(
	env: string,
	profiles: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	for (const [name, entry] of Object.entries(profiles)) {
		if (entry.env !== env) continue;
		return resolveProfile(name, profiles);
	}
	return null;
}

/** The first profile whose `endpoints[dialect]` equals `url` — endpoint
 *  match, not name match: zai-coding (not zai-general) is whichever
 *  profile actually declares the endpoint a generated row rides. */
export function profileForEndpoint(
	dialect: keyof ProviderEndpoints,
	url: string,
	profiles: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	for (const [name, entry] of Object.entries(profiles)) {
		if (entry.endpoints?.[dialect] !== url) continue;
		return resolveProfile(name, profiles);
	}
	return null;
}
