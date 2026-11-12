import { parseZaiModelIds } from "@klh/belt/bin/zai-catalog-rows.ts";
import type { ResolvedProvider } from "@klh/settings/connections";
import { fromOpenRouterCatalogRow } from "@klh/belt/bin/model-capabilities.ts";
import { ModelCapabilitiesSchema } from "@klh/buckle/src/wire-schemas.ts";
import { listedCapability, type Listed } from "./hub-catalog-fetch.ts";

/** Published wire support constrains selection; absent capability fields remain unknown. */
export function connectionModelRow(
	profile: ResolvedProvider,
	listing: Listed,
	id: string,
	template?: Record<string, unknown>,
): Record<string, unknown> | null {
	const connection = profile.connection;
	if (!connection || connection.protocol === "native") return null;
	if (listing.kind === "zai")
		try {
			parseZaiModelIds({ data: [{ id }] });
		} catch {
			return null;
		}
	const record =
		listedCapability(listing, id) ??
		(profile.provider === "openrouter"
			? fromOpenRouterCatalogRow(listing.rows.get(id), listing.observedAt)
			: null);
	const supported = record?.endpoints.value;
	const dialect =
		template?.dialect ??
		connection.protocol ??
		(supported?.includes("/v1/messages") && connection.endpoints.anthropic
			? "anthropic"
			: connection.endpoints.openai
				? "openai"
				: "anthropic");
	if (
		supported &&
		!supported.includes(
			dialect === "anthropic"
				? "/v1/messages"
				: (template?.adapter ?? connection.adapter) === "openai-responses"
					? "/v1/responses"
					: "/v1/chat/completions",
		)
	)
		return null;
	const raw = listing.rows.get(id) as Record<string, unknown> | null;
	const facts = ModelCapabilitiesSchema.safeParse({
		...(record?.contextTokens.value == null
			? {}
			: { context_length: record.contextTokens.value }),
		...(record?.maxOutputTokens.value == null
			? {}
			: { max_output_tokens: record.maxOutputTokens.value }),
		...Object.fromEntries(
			["context_length", "max_output_tokens", "reasoning"]
				.filter((key) => raw?.[key] !== undefined)
				.map((key) => [key, raw?.[key]]),
		),
		capability_source:
			connection.kind === "buckle"
				? raw?.capability_source
				: "provider-published",
	});
	const known =
		facts.success &&
		Object.keys(facts.data).some((key) => key !== "capability_source");
	return {
		...template,
		providerProfile: profile.name,
		model: id,
		dialect,
		...(template?.capabilities
			? {}
			: known
				? { capabilities: facts.data }
				: {}),
	};
}
