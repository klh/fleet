import {
	loadProviderConfig,
	resolveProvider,
	type ProviderEntry,
} from "@klh/speedy/src/provider-config.ts";
import { HubProfileSchema } from "@klh/suspenders/hooks/lib/stack-config.ts";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { renderProviderEnv } from "@klh/suspenders/hooks/lib/hub-providers.ts";
import { resolve } from "node:path";
import {
	discoverConnectionCatalogs,
	projectCatalogGroups,
} from "@klh/suspenders/deploy/hub-connection-catalog.ts";

/** CLI output: one captured profile map, no secret text on stdout or in argv. */
export async function emitPeerFiles(
	names: readonly string[],
	localGroups: Record<string, Record<string, unknown>[]>,
	aliases: Record<string, Record<string, unknown>[]>,
	envOut?: string,
	out?: string,
	profiles = loadProviderConfig(undefined, names),
	fetcher: typeof fetch = fetch,
): Promise<string> {
	if (out && envOut && resolve(out) === resolve(envOut))
		throw new Error("Peer route and credential outputs must differ");
	const selected = names.map((name) => {
		const profile = resolveProvider(name, profiles);
		if (profile?.connection?.kind !== "buckle")
			throw new Error(
				"Native routes require configured Buckle peer connections",
			);
		return profile;
	});
	const environment = renderProviderEnv(selected);
	if (environment && !envOut)
		throw new Error(
			"Keyed peer output requires a private --env-out destination",
		);
	const text = await emitPeerUpstreams(
		names,
		localGroups,
		profiles,
		fetcher,
		aliases,
	);
	if (envOut) atomicWrite0600(envOut, environment);
	if (out) atomicWrite0600(out, text);
	return text;
}

/** Native spokes select peers explicitly. Provider credentials never enter this path. */
export async function emitPeerUpstreams(
	names: readonly string[],
	localGroups: Record<string, Record<string, unknown>[]>,
	profiles: Record<string, ProviderEntry> = loadProviderConfig(
		undefined,
		names,
	),
	fetcher: typeof fetch = fetch,
	aliases: Record<string, Record<string, unknown>[]> = {},
): Promise<string> {
	if (!names.length || new Set(names).size !== names.length)
		throw new Error("Select unique peer connection names");
	const selected = names.map((name) => {
		const profile = resolveProvider(name, profiles);
		if (profile?.connection?.kind !== "buckle")
			throw new Error(
				"Native routes require configured Buckle peer connections",
			);
		return profile;
	});
	const parsed = HubProfileSchema.safeParse({
		host: "localhost",
		upstreams: { groups: aliases },
	});
	if (!parsed.success) throw new Error("Invalid native alias groups");
	for (const rows of Object.values(aliases))
		for (const row of rows) {
			if (
				!selected.some(
					(profile) =>
						row.providerProfile === profile.name ||
						(profile.env && row.api_key_env === profile.env),
				)
			)
				throw new Error("Native alias must bind a selected peer");
			if (
				Object.keys(row).some(
					(key) =>
						![
							"url",
							"dialect",
							"model",
							"providerProfile",
							"api_key_env",
							"adapter",
							"adapter_config",
							"provider",
							"buckle",
							"capabilities",
							"priority",
							"discover",
							"connection_limit",
							"visibility",
						].includes(key),
				)
			)
				throw new Error("Unsupported native alias field");
		}
	projectCatalogGroups(aliases, selected, new Map());
	const catalogs = await discoverConnectionCatalogs(selected, fetcher, aliases);
	const projected = projectCatalogGroups(aliases, selected, catalogs);
	return `${JSON.stringify({ version: 1, inherit_defaults: false, ...projected, groups: { ...localGroups, ...projected.groups } }, null, "\t")}\n`;
}
