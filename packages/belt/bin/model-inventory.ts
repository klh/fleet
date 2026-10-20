import type { ModelAccess, ModelPrice } from "./model-access.ts";
import type { ModelCapabilityRecord } from "./model-capabilities.ts";
import type { CheckRow } from "./remotes.ts";
import type { hubGatewayRoutes } from "./hubs.ts";

type HubRoutes = ReturnType<typeof hubGatewayRoutes>;

export interface ModelExposure {
	owner: string;
	kind: "belt" | "remote" | "hub" | "provider";
	evidence: "configured" | "catalog" | "probe";
	state: "up" | "down" | "unknown";
	provider?: string;
	routeModel?: string;
	endpoint?: string;
	routes?: string[];
	observedAt?: string;
}

export interface InventoryModel {
	key: string;
	id: string;
	provider: string | null;
	prices: Record<string, ModelPrice>;
	capability?: ModelCapabilityRecord;
	exposures: ModelExposure[];
}

export interface UnifiedModelInventory {
	generatedAt: string;
	models: InventoryModel[];
}

interface LocalSpecialist {
	role?: string;
	port?: number;
	model?: string;
	model_served?: string | null;
	state_label?: string;
}

interface InventorySources {
	specialists?: LocalSpecialist[];
	localObservedAt?: string | number;
	remotes?: Pick<
		CheckRow,
		| "machine"
		| "host"
		| "port"
		| "protocol"
		| "model"
		| "models"
		| "ok"
		| "last_seen"
	>[];
	remoteObservedAt?: string;
	hubs?: HubRoutes;
	access?: ModelAccess | null;
	capabilities?: ModelCapabilityRecord[];
}

/** One model ID can have several exposures. Configuration and catalog entries
 * are inventory evidence, never proof that an inference route is healthy. */
export function buildModelInventory(
	sources: InventorySources,
	now = Date.now(),
): UnifiedModelInventory {
	const models = new Map<string, InventoryModel>();
	const add = (
		id: string,
		exposure: ModelExposure,
		provider?: string,
		price?: ModelPrice,
	) => {
		if (!id.trim()) return;
		const key = `${provider ?? "unattributed"}:${id}`;
		const item = models.get(key) ?? {
			key,
			id,
			provider: provider ?? null,
			prices: {},
			exposures: [],
		};
		if (provider && price) item.prices[provider] = price;
		const duplicate = item.exposures.some(
			(row) =>
				row.kind === exposure.kind &&
				row.owner === exposure.owner &&
				row.endpoint === exposure.endpoint &&
				row.evidence === exposure.evidence,
		);
		if (!duplicate) item.exposures.push(exposure);
		models.set(key, item);
	};
	const fresh = (value?: string | number) => {
		const at = typeof value === "number" ? value : Date.parse(value ?? "");
		return Number.isFinite(at) && at <= now && now - at <= 120_000;
	};
	const observedAt = (value?: string | number) =>
		value === undefined ? undefined : new Date(value).toISOString();
	for (const row of sources.specialists ?? []) {
		const id = row.model_served ?? row.model;
		if (!id || id === "model not loaded") continue;
		add(
			id,
			{
				owner: "This Mac",
				kind: "belt",
				evidence: row.model_served ? "probe" : "configured",
				provider: "belt",
				state: fresh(sources.localObservedAt)
					? row.state_label === "ready" && row.model_served
						? "up"
						: "unknown"
					: "unknown",
				...(Number.isFinite(row.port) ? { endpoint: `:${row.port}` } : {}),
				...(sources.localObservedAt
					? { observedAt: observedAt(sources.localObservedAt) }
					: {}),
			},
			"belt",
		);
	}
	for (const row of sources.remotes ?? []) {
		if (row.protocol === "immich") continue;
		const ids = new Set([row.model, ...(row.models ?? [])].filter(Boolean));
		for (const id of ids) {
			if (!id) continue;
			add(id, {
				owner: row.machine,
				kind: "remote",
				evidence: row.models?.includes(id) ? "probe" : "configured",
				state: fresh(sources.remoteObservedAt)
					? row.ok
						? "up"
						: "down"
					: "unknown",
				endpoint: `${row.host}:${row.port}`,
				...(sources.remoteObservedAt
					? { observedAt: sources.remoteObservedAt }
					: {}),
			});
		}
	}
	for (const hub of sources.hubs ?? []) {
		for (const id of hub.models) {
			const identity = hub.providerModelIds[id];
			const aliases = hub.routesByModel[id] ?? [];
			const candidates = new Set(
				aliases
					.map((route) => route.split("/")[0])
					.filter(
						(key): key is string =>
							typeof key === "string" && hub.providerIntents.includes(key),
					),
			);
			if (identity?.provider) candidates.add(identity.provider);
			if (candidates.size === 0 && hub.providerIntents.length === 1) {
				const onlyProvider = hub.providerIntents[0];
				if (onlyProvider) candidates.add(onlyProvider);
			}
			const provider = candidates.size === 1 ? [...candidates][0] : undefined;
			const modelId =
				identity?.id ??
				(provider && id.startsWith(`${provider}/`)
					? id.slice(provider.length + 1)
					: id);
			add(
				modelId,
				{
					owner: hub.name,
					kind: "hub",
					evidence: "configured",
					state: "unknown",
					...(provider ? { provider } : {}),
					routeModel: id,
					routes: aliases,
				},
				provider,
			);
		}
	}
	const access = sources.access;
	for (const row of access?.copilot.models ?? [])
		add(
			row.id,
			{
				owner: "IKEA Copilot",
				kind: "provider",
				evidence: "catalog",
				state: "unknown",
				provider: "copilot",
			},
			"copilot",
			row.price,
		);
	for (const row of access?.openrouter.models ?? [])
		add(
			row.id,
			{
				owner: "OpenRouter",
				kind: "provider",
				evidence: "catalog",
				state: "unknown",
				provider: "openrouter",
			},
			"openrouter",
			row.price,
		);
	for (const id of access?.zaiAccount.modelIds ?? [])
		add(
			id,
			{
				owner: "Z.ai",
				kind: "provider",
				evidence: "catalog",
				state: "unknown",
				provider: "zai",
			},
			"zai",
			access?.zaiPricing.models.find((row) => row.id === id)?.price,
		);
	for (const capability of sources.capabilities ?? []) {
		const key = `${capability.provider}:${capability.modelId}`;
		const model = models.get(key);
		if (model) model.capability = capability;
	}
	return {
		generatedAt: new Date(now).toISOString(),
		models: [...models.values()]
			.map((item) => ({
				...item,
				exposures: item.exposures.sort((a, b) =>
					`${a.kind}:${a.owner}:${a.endpoint ?? ""}`.localeCompare(
						`${b.kind}:${b.owner}:${b.endpoint ?? ""}`,
					),
				),
			}))
			.sort((a, b) => a.key.localeCompare(b.key)),
	};
}
