import type { ResolvedProvider } from "@klh/settings/connections";
import type { CatalogKind } from "./hub-catalog-fetch.ts";
import { projectConnectionGroups } from "./hub-connections.ts";
import {
	integrationHeaders,
	isRetiredRelay,
} from "./canonical-catalog-policy.ts";
import { connectionModelRow } from "./connection-model-row.ts";

import {
	cachedConnectionCatalog,
	type CatalogObservation,
} from "./connection-catalog-cache.ts";
export type ConnectionCatalogs = ReadonlyMap<string, CatalogObservation>;
type Groups = Record<string, Record<string, unknown>[]>;

/** Only selected connections are queried. Failure isolates one provider. */
export async function discoverConnectionCatalogs(
	required: readonly ResolvedProvider[],
	fetcher: typeof fetch = fetch,
	groups: Groups = {},
): Promise<ConnectionCatalogs> {
	const collect = async (profile: ResolvedProvider) => {
		const connection = profile.connection;
		if (!connection?.discovery.enabled || connection.protocol === "native")
			return null;
		const endpoint =
			connection.endpoints.openai ?? connection.endpoints.anthropic;
		if (!endpoint) return null;
		const url = new URL(endpoint);
		const kind: CatalogKind =
			url.hostname === "api.githubcopilot.com"
				? "copilot"
				: url.hostname === "api.z.ai"
					? "zai"
					: "openai";
		const source =
			connection.endpoints.catalog ??
			(profile.provider === "openrouter"
				? `${endpoint.replace(/\/$/, "")}${/\/v\d+$/.test(url.pathname) ? "/models/user" : "/v1/models/user"}`
				: kind === "copilot"
					? `${url.origin}/models`
					: kind === "zai"
						? `${url.origin}/api/paas/v4/models`
						: `${endpoint.replace(/\/$/, "")}${/\/v\d+$/.test(url.pathname) ? "/models" : "/v1/models"}`);
		const listing = await cachedConnectionCatalog(
			{
				kind,
				source,
				headers: integrationHeaders(profile, groups),
				maxBytes:
					profile.provider === "openrouter" ? 8 * 1024 * 1024 : 1024 * 1024,
				...(connection.protocol === "anthropic" && kind === "openai"
					? { auth: "anthropic" as const }
					: {}),
			},
			profile.key,
			fetcher,
		);
		return [profile.name, listing] as const;
	};
	const entries: (readonly [string, CatalogObservation] | null)[] = [];
	for (let offset = 0; offset < required.length; offset += 4)
		entries.push(
			...(await Promise.all(required.slice(offset, offset + 4).map(collect))),
		);
	return new Map(entries.filter((entry) => entry !== null));
}

/** Identity routes and configured aliases share the same endpoint and policy. */
export function projectCatalogGroups(
	groups: Groups,
	required: readonly ResolvedProvider[],
	catalogs: ConnectionCatalogs,
): { groups: Groups; catalog_status: Record<string, unknown> } {
	const canonical = projectConnectionGroups(groups, required);
	const output: Groups = Object.assign(Object.create(null), canonical);
	const templates = new Map<string, Record<string, unknown>>();
	for (const row of Object.values(canonical).flat()) {
		const key = `${row.providerProfile}\0${row.model}`;
		if (!templates.has(key)) templates.set(key, row);
	}
	const status: Record<string, unknown> = {};
	for (const [group, rows] of Object.entries(output)) {
		if (rows.some(isRetiredRelay))
			status[`unbound:${group}`] = {
				state: "unavailable",
				reason: "retired-relay-without-canonical-binding",
			};
		output[group] = rows.filter((row) => !isRetiredRelay(row));
	}
	for (const profile of required) {
		const connection = profile.connection;
		if (!connection?.discovery.enabled) continue;
		const listing = catalogs.get(profile.name);
		status[profile.name] =
			listing?.state === "listed"
				? {
						state: "listed",
						source: listing.source,
						observedAt: listing.observedAt,
						count: listing.rows.size,
						ageMs: Math.max(0, Date.now() - Date.parse(listing.observedAt)),
					}
				: {
						state: "unavailable",
						reason: listing?.state ?? "catalog-not-observed",
						lastGoodObservedAt: listing?.lastGoodObservedAt ?? null,
					};
		for (const group of Object.keys(output))
			output[group] = (output[group] ?? []).flatMap((row) => {
				if (row.providerProfile !== profile.name) return [row];
				if (listing?.state !== "listed" || !listing.rows.has(String(row.model)))
					return [];
				const observed = connectionModelRow(
					profile,
					listing,
					String(row.model),
					row,
				);
				return observed ? [observed] : [];
			});
		if (listing?.state !== "listed") continue;
		for (const id of listing.rows.keys()) {
			const template = templates.get(`${profile.name}\0${id}`);
			const headers = integrationHeaders(profile, canonical);
			const observed = connectionModelRow(
				profile,
				listing,
				id,
				template ??
					(Object.keys(headers).length
						? { adapter_config: { headers } }
						: undefined),
			);
			if (!observed) continue;
			const rows =
				projectConnectionGroups({ [id]: [observed] }, [profile])[id] ?? [];
			const existing = output[id] ?? [];
			if (
				!existing.some(
					(item) => item.providerProfile === profile.name && item.model === id,
				)
			)
				output[id] = [...existing, ...rows];
		}
	}
	return { groups: output, catalog_status: status };
}
