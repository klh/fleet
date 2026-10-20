// OpenRouter's public catalog is the source for generated free-model routes.
// This file contains no credentials. Buckle forwards through the owned
// LiteLLM engine; only LiteLLM receives the OpenRouter inference key.
import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_FREE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const ZERO_PRICE = /^0(?:\.0+)?$/;
const FREE_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*:free$/i;

type CatalogModel = {
	id?: unknown;
	architecture?: {
		input_modalities?: unknown;
		output_modalities?: unknown;
		modality?: unknown;
	};
	pricing?: { prompt?: unknown; completion?: unknown; request?: unknown };
};

export type FreeRoute = {
	url: string;
	dialect: "openai";
	adapter: "openai-compat";
	api_key_env: "LITELLM_KEY";
	model: string;
};

export type FreeSnapshot = {
	version: 1;
	source: typeof OPENROUTER_CATALOG_URL;
	generated_at: string;
	groups: Record<string, FreeRoute[]>;
	excluded_free_models: Array<{ id: string; reason: string }>;
};

const routeForId = (id: string): FreeRoute => ({
	url: "http://127.0.0.1:4100",
	dialect: "openai",
	adapter: "openai-compat",
	api_key_env: "LITELLM_KEY",
	model: `openrouter/${id}`,
});

const textCapable = (model: CatalogModel): boolean => {
	const arch = model.architecture;
	if (!arch) return false;
	if (
		Array.isArray(arch.input_modalities) &&
		Array.isArray(arch.output_modalities)
	) {
		return (
			arch.input_modalities.includes("text") &&
			arch.output_modalities.includes("text")
		);
	}
	return (
		typeof arch.modality === "string" &&
		/^text(?:\+[^-]+)?->text$/.test(arch.modality)
	);
};

export function classifyFreeModels(input: unknown): {
	ids: string[];
	excluded: Array<{ id: string; reason: string }>;
} {
	if (
		!input ||
		typeof input !== "object" ||
		!Array.isArray((input as { data?: unknown }).data)
	)
		throw new Error("OpenRouter catalog has no data array");
	const models = (input as { data: CatalogModel[] }).data;
	const ids: string[] = [];
	const excluded: Array<{ id: string; reason: string }> = [];
	for (const model of models) {
		if (typeof model?.id !== "string" || !model.id.endsWith(":free")) continue;
		const price = model.pricing;
		const reason = !FREE_ID.test(model.id)
			? "unsupported model ID"
			: !textCapable(model)
				? "no text input and output"
				: !price ||
						![price.prompt, price.completion].every(
							(value) => typeof value === "string" && ZERO_PRICE.test(value),
						)
					? "prompt or completion price is nonzero or unreported"
					: price.request !== undefined &&
							!(
								typeof price.request === "string" &&
								ZERO_PRICE.test(price.request)
							)
						? "request fee is nonzero or unreported"
						: null;
		if (reason) excluded.push({ id: model.id, reason });
		else ids.push(model.id);
	}
	return {
		ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)),
		excluded: excluded.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

export const eligibleFreeModelIds = (input: unknown): string[] =>
	classifyFreeModels(input).ids;

export function snapshotFromCatalog(
	catalog: unknown,
	now = new Date(),
): FreeSnapshot {
	const { ids, excluded } = classifyFreeModels(catalog);
	if (ids.length === 0)
		throw new Error(
			"OpenRouter catalog has no eligible free text models; retaining the previous snapshot",
		);
	return {
		version: 1,
		source: OPENROUTER_CATALOG_URL,
		generated_at: now.toISOString(),
		groups: Object.fromEntries(
			ids.map((id) => [`openrouter/${id}`, [routeForId(id)]]),
		),
		excluded_free_models: excluded,
	};
}

export async function fetchFreeSnapshot(
	fetcher: typeof fetch = fetch,
): Promise<FreeSnapshot> {
	const response = await fetcher(OPENROUTER_CATALOG_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok || !response.body)
		throw new Error(`OpenRouter catalog HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CATALOG_BYTES)
				throw new Error("OpenRouter catalog exceeds 8 MiB");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const joined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return snapshotFromCatalog(JSON.parse(new TextDecoder().decode(joined)));
}

export function writeFreeSnapshot(
	path: string,
	snapshot: FreeSnapshot,
): boolean {
	if (!path.startsWith("/"))
		throw new Error("OpenRouter snapshot path must be absolute");
	try {
		if (lstatSync(path).isSymbolicLink())
			throw new Error("OpenRouter snapshot path is a symlink");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const next = `${JSON.stringify(snapshot, null, 2)}\n`;
	const current = (() => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	})();
	let routesChanged = true;
	if (current) {
		try {
			const parsed = JSON.parse(current) as FreeSnapshot;
			routesChanged =
				JSON.stringify(parsed.groups) !== JSON.stringify(snapshot.groups);
		} catch {
			/* replace a malformed old snapshot only after fresh catalog validation */
		}
	}
	const temp = join(
		dirname(path),
		`.openrouter-free-${crypto.randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temp, next, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* preserve the original error */
		}
		throw error;
	}
	return routesChanged;
}

export function mergedHubUpstreams(
	hub: HubProfile,
	now = Date.now(),
): Record<string, Array<Record<string, unknown>>> {
	const explicit = hub.upstreams?.groups ?? {};
	const path = hub.upstreams?.openrouter_free_catalog_file;
	if (!path) return explicit;
	if (
		hub.buckle_prefs?.allow_cloud !== true ||
		!hub.secrets?.upstream_keys?.LITELLM_KEY
	)
		throw new Error(
			"OpenRouter free routes require allow_cloud and LITELLM_KEY hub secret path",
		);
	const doc = JSON.parse(readFileSync(path, "utf8")) as FreeSnapshot;
	if (
		doc?.version !== 1 ||
		doc.source !== OPENROUTER_CATALOG_URL ||
		!doc.groups ||
		typeof doc.groups !== "object"
	)
		throw new Error("invalid OpenRouter free catalog snapshot");
	const age = now - Date.parse(doc.generated_at);
	if (!Number.isFinite(age) || age < 0 || age > OPENROUTER_FREE_MAX_AGE_MS)
		throw new Error(
			"OpenRouter free catalog snapshot is stale; refresh before hubctl push",
		);
	for (const [group, deployments] of Object.entries(doc.groups)) {
		const id = group.slice("openrouter/".length);
		if (
			!group.startsWith("openrouter/") ||
			!FREE_ID.test(id) ||
			!Array.isArray(deployments) ||
			deployments.length !== 1 ||
			JSON.stringify(deployments[0]) !== JSON.stringify(routeForId(id))
		)
			throw new Error("invalid OpenRouter free catalog route");
	}
	return { ...doc.groups, ...explicit };
}
