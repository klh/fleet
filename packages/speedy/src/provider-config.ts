// src/provider-config.ts — W1124.8.1: the ONE central provider schema +
// resolver for the klh stack. Provider profiles live ONLY in the private
// machine-level stack.yaml (mode 600): the raw operator key is the CENTRAL
// value; `env` is an OUTPUT binding — the env var NAME a gateway/hubctl
// materializes into the target's 0600 env file at runtime. There is NO
// ambient-env read and NO key_file fallback here: values flow one way,
// private config → resolved profile → materialized runtime binding.
// Consumers: hubctl secret delivery (W1124.8.2.1), belt runtime-heal,
// buckle gateway bootstrap. Pure module — node:fs + yaml only, no
// fleet-internal imports (the file ports verbatim into DEPS closures).
import { readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/** Wire dialect roots a profile may declare. Every value must be an
 *  http(s) URL. `catalog` points at PUBLIC model capability/cost data —
 *  never a credential surface. */
export interface ProviderEndpoints {
	/** OpenAI-dialect base (incl. /v1 where the wire needs it). */
	openai?: string;
	/** Anthropic-dialect base. */
	anthropic?: string;
	/** Model catalog snapshot URL (public data). */
	catalog?: string;
}

/** One named provider profile in the private stack.yaml `providers` map
 *  (e.g. zai-coding, zai-general). The raw key lives HERE — central,
 *  operator-owned; repos never carry it. */
export interface ProviderEntry {
	/** Provider family the profile rides (routing/upstream vocabulary). */
	provider: string;
	/** Central raw operator secret. Output-only: never logged, never echoed
	 *  into an error, only bound to the profile's `env` at runtime. */
	key: string;
	/** Env var NAME the value binds to at runtime (OUTPUT binding). */
	env?: string;
	endpoints?: ProviderEndpoints;
}

/** The resolved view consumers act on: profile id + family + raw key +
 *  output binding + declared endpoints. */
export interface ResolvedProvider {
	/** The profile key in the providers map (stable routing identity). */
	name: string;
	provider: string;
	/** Raw central operator secret — handle like a credential. */
	key: string;
	/** Output env binding, or null when the profile declares none. */
	env: string | null;
	endpoints: ProviderEndpoints;
}

/** Private stack.yaml location — KLH_STACK overrides (tests). */
export const PROVIDER_STACK_PATH = (): string =>
	process.env.KLH_STACK ?? join(homedir(), ".config", "klh", "stack.yaml");

const MAX_STACK_BYTES = 1024 * 1024;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const ENDPOINT_FIELDS = ["openai", "anthropic", "catalog"] as const;

const isHttpUrl = (v: unknown): v is string =>
	typeof v === "string" &&
	(v.startsWith("http://") || v.startsWith("https://"));

function fail(msg: string): never {
	throw new Error(`provider config: ${msg}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate an already-parsed stack's `providers` slice — pure: reads the
 *  value, returns the typed record, mutates nothing; every non-provider
 *  stack field stays the caller's. Throws redacted messages (profile names
 *  only — never key material, never values). */
export function validateProviderConfig(
	input: unknown,
): Record<string, ProviderEntry> {
	if (input === undefined || input === null) return {};
	if (!isRecord(input)) {
		fail("providers must be a map of named profiles");
	}
	const out: Record<string, ProviderEntry> = {};
	const envOwners = new Map<string, string>();
	for (const [name, raw] of Object.entries(input)) {
		if (!isRecord(raw)) fail(`profile ${name} must be a mapping`);
		const row = raw;
		if (typeof row.provider !== "string" || row.provider.trim().length === 0) {
			fail(`profile ${name}: provider family is required`);
		}
		if (typeof row.key !== "string" || row.key.trim().length === 0) {
			fail(`profile ${name}: key must be a non-empty central value`);
		}
		let env: string | undefined;
		if (row.env !== undefined) {
			if (typeof row.env !== "string" || !ENV_NAME_RE.test(row.env)) {
				fail(`profile ${name}: env must be an env var NAME (OUTPUT binding)`);
			}
			env = row.env;
		}
		const endpoints: ProviderEndpoints = {};
		if (row.endpoints !== undefined) {
			if (!isRecord(row.endpoints)) {
				fail(`profile ${name}: endpoints must be a mapping`);
			}
			const eps = row.endpoints;
			for (const field of ENDPOINT_FIELDS) {
				const v = eps[field];
				if (v === undefined) continue;
				if (!isHttpUrl(v)) {
					fail(`profile ${name}: endpoints.${field} must be an http(s) URL`);
				}
				endpoints[field] = v;
			}
		}
		if (env) {
			const owner = envOwners.get(env);
			if (owner !== undefined) {
				fail(`profiles ${owner} and ${name} both bind env ${env}`);
			}
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

/** Load + validate the private stack's provider profiles. Enforces the
 *  file posture: regular file, mode 600, ≤1 MiB. A stack without a
 *  providers section is a valid empty config ({}). */
export function loadProviderConfig(
	path: string = PROVIDER_STACK_PATH(),
): Record<string, ProviderEntry> {
	let st: Stats;
	try {
		st = statSync(path);
	} catch {
		fail(`stack config not readable at ${path}`);
	}
	if (!st.isFile()) fail(`stack config ${path} must be a regular file`);
	if ((st.mode & 0o777) !== 0o600) {
		fail(
			`stack config ${path} must be mode 600 (got ${(st.mode & 0o777).toString(8)})`,
		);
	}
	if (st.size > MAX_STACK_BYTES) {
		fail(`stack config ${path} is over the 1 MiB cap`);
	}
	let parsed: unknown;
	try {
		parsed = parse(readFileSync(path, "utf8"));
	} catch {
		fail(`stack config ${path} is not parseable YAML`);
	}
	const providers = isRecord(parsed)
		? (parsed as { providers?: unknown }).providers
		: undefined;
	return validateProviderConfig(providers);
}

/** Resolve one profile by name — absent (optional) profile → null; an
 *  invalid CONFIGURED profile throws (redacted). */
export function resolveProvider(
	name: string,
	providers: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	const entry = providers[name];
	if (!entry) return null;
	const revalidated = validateProviderConfig({ [name]: entry });
	const p = revalidated[name];
	return {
		name,
		provider: p.provider,
		key: p.key,
		env: p.env ?? null,
		endpoints: p.endpoints ?? {},
	};
}
