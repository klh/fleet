import type { ResolvedProvider } from "@klh/settings/connections";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** Preserve the existing non-secret Copilot identity header, never arbitrary auth headers. */
export function integrationHeaders(
	profile: ResolvedProvider,
	groups: Record<string, Record<string, unknown>[]>,
): Record<string, string> {
	const ids = new Set<string>();
	for (const row of Object.values(groups).flat()) {
		if (
			row.providerProfile !== profile.name &&
			(!profile.env || row.api_key_env !== profile.env)
		)
			continue;
		const value = (
			row.adapter_config as { headers?: Record<string, unknown> } | undefined
		)?.headers?.["copilot-integration-id"];
		if (value === undefined) continue;
		if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value))
			throw new Error("Invalid catalog integration header");
		ids.add(value);
	}
	if (ids.size > 1) throw new Error("Conflicting catalog integration headers");
	const id = ids.values().next().value;
	return id ? { "copilot-integration-id": id } : {};
}

/** A selected canonical connection supersedes its old relay snapshot generator. */
export function canonicalCatalogHub(
	hub: HubProfile,
	required: readonly ResolvedProvider[],
): HubProfile {
	const upstreams = { ...hub.upstreams };
	for (const profile of required) {
		if (profile.connection?.kind !== "provider") continue;
		if (profile.provider === "openrouter")
			delete upstreams.openrouter_free_catalog_file;
		if (profile.provider === "zai") delete upstreams.zai_catalog_file;
	}
	return { ...hub, upstreams };
}

/** A retired local relay cannot remain an advertised fallback under canonical routing. */
export function isRetiredRelay(row: Record<string, unknown>): boolean {
	try {
		const url = new URL(String(row.url));
		return (
			url.port === "4100" &&
			[
				"127.0.0.1",
				"localhost",
				"[::1]",
				"host.docker.internal",
				"gateway.docker.internal",
			].includes(url.hostname)
		);
	} catch {
		return false;
	}
}
