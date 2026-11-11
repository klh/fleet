import type { Model } from "@earendil-works/pi-ai";
import {
	ModelListResponseSchema,
	ModelRowSchema,
} from "@klh/buckle/src/wire-schemas.ts";
import { z } from "zod";
import type { RunnerProfile } from "../api/contracts.ts";
import { readWireJson } from "../api/wire.ts";

const CatalogEnvelopeSchema = ModelListResponseSchema.extend({
	data: z.array(z.unknown()),
});
const CatalogIdentitySchema = ModelRowSchema.pick({ id: true });
const SelectedModelSchema = ModelRowSchema.required({
	context_length: true,
	max_output_tokens: true,
	reasoning: true,
	capability_source: true,
});
type SelectedModel = z.infer<typeof SelectedModelSchema>;

/** Discover selected routes only; absence never becomes a fabricated SDK limit. */
export async function discoverRunnerModels(options: {
	baseUrl: string;
	adminKey: string;
	profiles: Readonly<Record<string, Pick<RunnerProfile, "provider" | "model">>>;
	fetch?: (url: URL, init?: RequestInit) => Promise<Response>;
}) {
	const ids = new Set(
		Object.values(options.profiles).map((profile) => {
			if (profile.provider !== "belt")
				throw new Error("runner.unsupported_provider");
			return profile.model;
		}),
	);
	if (!ids.size) throw new Error("runner.model_profiles_required");
	let endpoint: URL;
	try {
		endpoint = new URL("/v1/models", options.baseUrl);
		if (
			endpoint.username ||
			endpoint.password ||
			!["http:", "https:"].includes(endpoint.protocol) ||
			(endpoint.protocol === "http:" &&
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
		)
			throw new Error();
	} catch {
		throw new Error("runner.invalid_model_catalog_endpoint");
	}
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(endpoint, {
			headers: { authorization: `Bearer ${options.adminKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(3000),
		});
	} catch {
		throw new Error("runner.model_catalog_unavailable");
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error(
			response.status === 401 || response.status === 403
				? "runner.model_catalog_unauthorized"
				: "runner.model_catalog_unavailable",
		);
	}
	let body: unknown;
	try {
		body = await readWireJson(response);
	} catch {
		throw new Error("runner.model_catalog_unavailable");
	}
	const envelope = CatalogEnvelopeSchema.safeParse(body);
	if (!envelope.success) throw new Error("runner.model_catalog_invalid");
	const selected = new Map<string, SelectedModel>();
	for (const raw of envelope.data.data) {
		const identity = CatalogIdentitySchema.safeParse(raw);
		if (!identity.success || !ids.has(identity.data.id)) continue;
		if (selected.has(identity.data.id))
			throw new Error("runner.model_catalog_ambiguous");
		const row = SelectedModelSchema.safeParse(raw);
		if (!row.success) throw new Error("runner.model_capabilities_incomplete");
		selected.set(row.data.id, row.data);
	}
	const capabilities = [...ids].map((id) => {
		const row = selected.get(id);
		if (!row) throw new Error("runner.model_not_advertised");
		return row;
	});
	// SDK requires costs; these existing zero accounting placeholders are not discovered pricing.
	const models: Model<"openai-completions">[] = capabilities.map((row) => ({
		id: row.id,
		name: row.id,
		api: "openai-completions",
		provider: "belt",
		baseUrl: new URL("/v1", endpoint).href,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: row.reasoning,
		contextWindow: row.context_length,
		maxTokens: row.max_output_tokens,
	}));
	return { models, capabilities };
}
