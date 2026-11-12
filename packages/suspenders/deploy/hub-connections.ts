import { z } from "zod";
import type { ResolvedProvider } from "@klh/settings/connections";
import { assertProviderPoolPolicy } from "@klh/buckle/src/provider-admission-core.ts";
import type { GatewayPolicy } from "@klh/buckle/src/policy.ts";
import { resolveAdapter } from "@klh/buckle/src/adapters/index.ts";

/** Canonical account settings overlay only an explicit native pacing policy. */
export function projectConnectionPolicy(
	gateway: GatewayPolicy | undefined,
	required: readonly ResolvedProvider[],
): GatewayPolicy | undefined {
	const accounts = required.filter(
		(profile) =>
			profile.connection?.kind === "provider" && profile.connection.account,
	);
	if (!accounts.length) return gateway;
	const pools = { ...gateway?.provider_pools };
	const seen = new Map<string, string>();
	for (const profile of accounts) {
		const connection = profile.connection;
		if (connection?.kind !== "provider" || !connection.account) continue;
		const account = connection.account,
			base = pools[account.id];
		const concurrency = account.concurrency ?? base?.concurrency;
		const policy = {
			...base,
			...account.pacing,
			concurrency,
			maxOutstanding:
				account.queue_limit === undefined
					? base?.maxOutstanding
					: (concurrency ?? 0) + account.queue_limit,
		};
		assertProviderPoolPolicy(policy);
		const previous = seen.get(account.id),
			serialized = JSON.stringify({ provider: connection.provider, policy });
		if (previous && previous !== serialized)
			throw new Error("Conflicting policy for one provider account");
		seen.set(account.id, serialized);
		pools[account.id] = policy;
	}
	return { ...gateway, provider_pools: pools };
}

export function projectConnectionGroups(
	groups: Record<string, Record<string, unknown>[]>,
	required: readonly ResolvedProvider[],
) {
	return Object.fromEntries(
		Object.entries(groups).map(([group, rows]) => [
			group,
			rows.flatMap((row) => {
				const named = required.find(
					(candidate) => row.providerProfile === candidate.name,
				);
				const byEnv = required.find(
					(candidate) => candidate.env && row.api_key_env === candidate.env,
				);
				if (
					byEnv &&
					typeof row.providerProfile === "string" &&
					row.providerProfile !== byEnv.name
				)
					throw new Error(
						"Connection profile and credential output binding disagree",
					);
				const profile = named ?? byEnv;
				const connection = profile?.connection;
				if (!profile || !connection) return [row];
				if (connection.protocol === "native")
					throw new Error(
						"Native provider cannot project to a chat deployment",
					);
				const dialect = z.enum(["openai", "anthropic"]).parse(row.dialect);
				const url = connection.endpoints[dialect];
				if (!url)
					throw new Error("Selected connection has no matching wire endpoint");
				const model =
					typeof row.model === "string"
						? row.model
						: (connection.default_model ?? group);
				if (
					!connection.allowed_models.includes("*") &&
					!connection.allowed_models.includes(model)
				)
					return [];
				const adapter =
					connection.kind === "buckle"
						? dialect === "openai"
							? "openai-compat"
							: "anthropic"
						: connection.adapter === "openai"
							? "openai-compat"
							: connection.adapter;
				try {
					resolveAdapter({ dialect, adapter });
				} catch {
					throw new Error("Unsupported connection adapter");
				}
				const config =
					row.adapter_config === undefined
						? {}
						: z.record(z.string(), z.unknown()).parse(row.adapter_config);
				if (connection.kind === "buckle") {
					delete config.provider_pool;
					delete config.provider_concurrency_error_codes;
					if (Object.keys(config).length)
						throw new Error("Unsupported peer adapter extension");
				}
				if (connection.kind === "provider" && connection.account)
					config.provider_pool = connection.account.id;
				const { api_key_env: _discard, ...rest } = row;
				return [
					{
						...rest,
						url,
						model,
						adapter,
						adapter_config: config,
						provider: profile.provider,
						providerProfile: profile.name,
						buckle: connection.kind === "buckle",
						discover: connection.discovery.enabled,
						...(profile.key !== undefined && profile.env
							? { api_key_env: profile.env }
							: {}),
						...(connection.transport?.max_connections === undefined
							? {}
							: { connection_limit: connection.transport.max_connections }),
					},
				];
			}),
		]),
	);
}
