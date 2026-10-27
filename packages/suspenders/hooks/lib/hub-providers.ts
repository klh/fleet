// hooks/lib/hub-providers.ts — W1124.8.2.1: central provider profiles
// (packages/speedy/src/provider-config.ts, W1124.8.1) materialized into hub
// deployment. A hub profile declares the profiles it REQUIRES
// (stack.yaml hub.provider_requirements); hubctl push resolves them through
// the shared resolver and renders the 0600 provider.env ON the target —
// the raw central key is bound to the profile's declared env NAME and never
// printed, logged, or committed. No legacy key_file fallback: the central
// value IS the value (W1124.8.1 contract); `env` is an OUTPUT binding only.
import {
	type ProviderEndpoints,
	type ProviderEntry,
	type ResolvedProvider,
	loadProviderConfig,
	resolveProvider,
} from "../../../speedy/src/provider-config.ts";
import type { HubProfile } from "./stack-config.ts";

/** The hub-side env file hubctl push materializes (compose env_file). */
export const PROVIDER_ENV_FILENAME = "provider.env";

/** A hub's required provider profiles, resolved — one row per declared
 *  name. An unknown profile, or one without an env binding, throws
 *  (redacted: profile names only). No requirements → [] WITHOUT reading
 *  provider config (hubs that opt out never load the secret surface). */
export function requiredProviders(
	hub: Pick<HubProfile, "provider_requirements">,
	providers?: Record<string, ProviderEntry>,
): ResolvedProvider[] {
	const names = hub.provider_requirements ?? [];
	if (names.length === 0) return [];
	const map = providers ?? loadProviderConfig();
	return names.map((name) => {
		const r = resolveProvider(name, map);
		if (!r)
			throw new Error(
				`hub requires provider profile "${name}" — stack.yaml providers has no such profile`,
			);
		if (!r.env)
			throw new Error(
				`provider profile "${name}" declares no env binding — hub delivery needs profile.env`,
			);
		return r;
	});
}

/** The env file body: one KEY=value line per required profile. Empty
 *  requirements render an empty file (compose env_file stays valid — the
 *  same posture upstream.env has when no ladder keys are declared). */
export function renderProviderEnv(
	required: readonly ResolvedProvider[],
): string {
	const lines = required.map((r) => `${r.env}=${r.key}`);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Load provider config with every failure → null (missing stack, wrong
 *  mode, malformed) — the admin plane's inventory lists what resolves, it
 *  never dies on operator config. */
export function tryLoadProviderConfig(): Record<string, ProviderEntry> | null {
	try {
		return loadProviderConfig();
	} catch {
		return null;
	}
}

/** One NON-SECRET profile row for the hub admin feed: id, family, output
 *  binding, declared endpoints. Raw key material never enters the row. */
export interface ProviderProfileRow {
	name: string;
	provider: string;
	env: string | null;
	endpoints: ProviderEndpoints;
}

/** The central profiles summary — names/endpoints/bindings only. */
export function centralProviderProfiles(
	profiles: Record<string, ProviderEntry>,
): ProviderProfileRow[] {
	return Object.entries(profiles).map(([name, p]) => ({
		name,
		provider: p.provider,
		env: p.env ?? null,
		endpoints: { ...(p.endpoints ?? {}) },
	}));
}

/** C74 (W1124.23.1): non-secret provider identity per env binding — the
 *  generator-side stamp for upstreams.hub.yaml deployment rows. SOFT: an
 *  unknown profile, an unbound profile, or an unloadable provider config
 *  simply contributes no identity (render never dies on operator config);
 *  raw key material never enters the map. */
export function providerIdentityByEnv(
	hub: Pick<HubProfile, "provider_requirements">,
	providers?: Record<string, ProviderEntry>,
): Record<string, { provider: string; providerProfile: string }> {
	const names = hub.provider_requirements ?? [];
	if (names.length === 0) return {};
	const map = providers ?? tryLoadProviderConfig();
	if (!map) return {};
	const out: Record<string, { provider: string; providerProfile: string }> = {};
	for (const name of names) {
		const r = resolveProvider(name, map);
		if (!r?.env) continue;
		out[r.env] = { provider: r.provider, providerProfile: r.name };
	}
	return out;
}
