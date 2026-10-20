import type { ModelAccess } from "./model-access.ts";
import {
	CapabilityRegistry,
	currentCapability,
	defaultCapabilitySnapshotPath,
	fromLocalSpecialist,
	fromOpenRouterCatalogRow,
	fromRemoteCatalogId,
	readCapabilitySnapshot,
	writeCapabilitySnapshot,
	type ModelCapabilityRecord,
} from "./model-capabilities.ts";
import { SPECIALISTS } from "./registry.ts";
import { ZAI_CATALOG_MAX_AGE_MS, ZAI_CATALOG_URL } from "./zai-catalog-rows.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FRESH_MS = 15 * 60_000;
const SOURCE_MAX_AGES = new Map([[ZAI_CATALOG_URL, ZAI_CATALOG_MAX_AGE_MS]]);

export interface CapabilityFeed {
	state: "available" | "partial";
	observedAt: string;
	maxAgeMs: number;
	records: ModelCapabilityRecord[];
	sources: {
		openrouter: "reachable" | "unavailable";
		persistence: "saved" | "unavailable";
	};
}

/** Catalog identity and prices are joined by provider and exact model ID. */
export const capabilityRegistryFromCatalogs = (
	access: ModelAccess,
	openRouterPayload: unknown,
	now = Date.now(),
): CapabilityRegistry => {
	const registry = new CapabilityRegistry();
	const observedAt = new Date(now).toISOString();
	for (const specialist of SPECIALISTS) {
		const record = fromLocalSpecialist(specialist, observedAt);
		if (record) registry.upsert(record);
	}
	const rawRows =
		openRouterPayload &&
		typeof openRouterPayload === "object" &&
		Array.isArray((openRouterPayload as { data?: unknown }).data)
			? (openRouterPayload as { data: unknown[] }).data
			: [];
	const prices = new Map(
		access.openrouter.models.map((model) => [model.id, model.price]),
	);
	const zaiAccount =
		access.zaiAccount.state === "available" &&
		access.zaiAccount.source === ZAI_CATALOG_URL &&
		access.zaiAccount.generatedAt
			? access.zaiAccount
			: null;
	const zaiAccountIds = new Set(zaiAccount?.modelIds ?? []);
	for (const rawRow of rawRows) {
		const record = fromOpenRouterCatalogRow(rawRow, observedAt);
		if (!record) continue;
		const price = prices.get(record.modelId);
		if (
			price &&
			access.openrouter.fetchedAt &&
			access.openrouter.state === "catalog reachable"
		) {
			record.cost = {
				value: price,
				source: access.openrouter.source,
				observedAt: access.openrouter.fetchedAt,
			};
		}
		registry.upsert(record);
	}
	for (const model of access.zaiPricing.models) {
		const at = access.zaiPricing.fetchedAt;
		if (!at || access.zaiPricing.state !== "pricing reachable") continue;
		const record = fromRemoteCatalogId(
			"zai",
			model.id,
			access.zaiPricing.source,
			at,
		);
		if (!record) continue;
		if (zaiAccount?.generatedAt && zaiAccountIds.has(model.id))
			record.locality = {
				value: "remote",
				source: ZAI_CATALOG_URL,
				observedAt: zaiAccount.generatedAt,
			};
		record.cost = {
			value: model.price,
			source: access.zaiPricing.source,
			observedAt: at,
		};
		registry.upsert(record);
	}
	if (zaiAccount?.generatedAt) {
		for (const id of zaiAccount.modelIds) {
			const record = fromRemoteCatalogId(
				"zai",
				id,
				ZAI_CATALOG_URL,
				zaiAccount.generatedAt,
			);
			if (record) registry.upsert(record);
		}
	}
	if (access.copilot.state === "catalog reachable") {
		for (const model of access.copilot.models) {
			const record = fromRemoteCatalogId(
				"copilot",
				model.id,
				"https://api.githubcopilot.com/models",
				access.ts,
			);
			if (!record) continue;
			record.cost = {
				value: model.price,
				source: "https://api.githubcopilot.com/models",
				observedAt: access.ts,
			};
			registry.upsert(record);
		}
	}
	return registry;
};

export const collectModelCapabilities = async (
	access: ModelAccess,
	options: {
		fetcher?: (input: string, init: RequestInit) => Promise<Response>;
		path?: string;
		now?: number;
	} = {},
): Promise<CapabilityFeed> => {
	const now = options.now ?? Date.now();
	const path = options.path ?? defaultCapabilitySnapshotPath();
	const previous = await readCapabilitySnapshot(path).catch(() => null);
	let payload: unknown = null;
	let openrouter: "reachable" | "unavailable" = "unavailable";
	try {
		const response = await (options.fetcher ?? fetch)(OPENROUTER_URL, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		payload = await response.json();
		if (
			!payload ||
			typeof payload !== "object" ||
			!Array.isArray((payload as { data?: unknown }).data)
		)
			throw new Error("catalog data missing");
		openrouter = "reachable";
	} catch {
		payload = null;
	}
	const registry = new CapabilityRegistry(
		previous?.state === "available" ? previous.registry.all() : [],
	);
	for (const record of capabilityRegistryFromCatalogs(
		access,
		payload,
		now,
	).all())
		registry.upsert(record, {
			preferLocality:
				record.provider === "zai" && record.locality.source === ZAI_CATALOG_URL,
		});
	let persistence: "saved" | "unavailable" = "saved";
	try {
		await writeCapabilitySnapshot(path, registry, now);
	} catch {
		persistence = "unavailable";
	}
	return {
		state:
			openrouter === "reachable" && persistence === "saved"
				? "available"
				: "partial",
		observedAt: new Date(now).toISOString(),
		maxAgeMs: FRESH_MS,
		records: registry
			.all()
			.map((record) =>
				currentCapability(record, FRESH_MS, now, SOURCE_MAX_AGES),
			),
		sources: { openrouter, persistence },
	};
};
