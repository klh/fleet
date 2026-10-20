// Browser-safe account inventory. A CLI sign-in and a direct API key are
// different routes; neither is inferred from the other's health probe.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SeatModel {
	id: string;
	name: string;
	vendor: string;
	endpoints: string[];
	buckle: boolean;
	routes: string[];
	price: ModelPrice;
}

export interface ModelPrice {
	status:
		| "free"
		| "priced"
		| "included-unreported"
		| "local-unpriced"
		| "unknown";
	inputUsdPerMillion: number | null;
	outputUsdPerMillion: number | null;
	requestUsd: number | null;
	note?: string;
}

export interface OpenRouterModel {
	id: string;
	name: string;
	price: ModelPrice;
}

export interface OpenRouterCatalog {
	state: "catalog reachable" | "catalog unavailable";
	source: string;
	fetchedAt: string | null;
	models: OpenRouterModel[];
	reason?: string;
}

export interface ZaiPricingCatalog {
	state: "pricing reachable" | "pricing unavailable";
	source: string;
	fetchedAt: string | null;
	models: OpenRouterModel[];
	reason?: string;
}

export interface ZaiAccountInventory {
	state: "available" | "unavailable";
	source: string | null;
	generatedAt: string | null;
	modelIds: string[];
}

export interface ModelAccess {
	ts: string;
	openrouter: OpenRouterCatalog;
	zaiPricing: ZaiPricingCatalog;
	zaiAccount: ZaiAccountInventory;
	copilot: {
		state: "catalog reachable" | "catalog unavailable" | "unconfigured";
		models: SeatModel[];
		reason?: string;
	};
	personal: {
		claude: "signed in" | "not signed in" | "unobserved";
		chatgpt: "signed in" | "not signed in" | "unobserved";
	};
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_MS = 15 * 60_000;
let openRouterCache: OpenRouterCatalog | null = null;
const ZAI_PRICING_URL = "https://docs.z.ai/guides/overview/pricing.md";
const ZAI_CACHE_MS = 15 * 60_000;
let zaiCache: ZaiPricingCatalog | null = null;

const unknownPrice = (): ModelPrice => ({
	status: "unknown",
	inputUsdPerMillion: null,
	outputUsdPerMillion: null,
	requestUsd: null,
});

const zaiRate = (value: string): number | null => {
	if (value.toLowerCase() === "free") return 0;
	const match = /^\\?\$(\d+(?:\.\d+)?)$/.exec(value);
	return match ? usdRate(match[1]) : null;
};

export const parseZaiPricing = (markdown: string): OpenRouterModel[] => {
	if (!markdown.includes("Prices per 1M tokens."))
		throw new Error("pricing unit missing");
	const models = new Map<string, OpenRouterModel>();
	for (const sourceLine of markdown.split("\n")) {
		const line = sourceLine.trimStart();
		if (!line.startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
		if (cells.length !== 5 || !/^GLM-[A-Za-z0-9.-]+$/.test(cells[0] ?? ""))
			continue;
		const id = (cells[0] ?? "").toLowerCase();
		const input = zaiRate(cells[1] ?? "");
		const output = zaiRate(cells[4] ?? "");
		const price =
			input === null || output === null
				? unknownPrice()
				: {
						status:
							input === 0 && output === 0
								? ("free" as const)
								: ("priced" as const),
						inputUsdPerMillion: input,
						outputUsdPerMillion: output,
						requestUsd: null,
					};
		models.set(id, { id, name: cells[0] ?? id, price });
	}
	if (models.size === 0) throw new Error("pricing table missing");
	return [...models.values()];
};

export const zaiPriceForId = (
	catalog: ZaiPricingCatalog,
	id: string,
): ModelPrice =>
	catalog.models.find((model) => model.id === id)?.price ?? unknownPrice();

export const zaiPricing = async (
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<ZaiPricingCatalog> => {
	if (
		zaiCache?.fetchedAt &&
		now - Date.parse(zaiCache.fetchedAt) < ZAI_CACHE_MS
	)
		return zaiCache;
	try {
		const response = await fetcher(ZAI_PRICING_URL, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`pricing HTTP ${response.status}`);
		const models = parseZaiPricing(await response.text());
		zaiCache = {
			state: "pricing reachable",
			source: ZAI_PRICING_URL,
			fetchedAt: new Date(now).toISOString(),
			models,
		};
		return zaiCache;
	} catch (error) {
		return {
			state: "pricing unavailable",
			source: ZAI_PRICING_URL,
			fetchedAt: zaiCache?.fetchedAt ?? null,
			models: zaiCache?.models ?? [],
			reason: error instanceof Error ? error.message : "pricing unavailable",
		};
	}
};

const usdRate = (value: unknown): number | null => {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (typeof value === "string" && !value.trim()) return null;
	const rate = Number(value);
	return Number.isFinite(rate) && rate >= 0 ? rate : null;
};

export const parseOpenRouterModels = (payload: unknown): OpenRouterModel[] => {
	if (
		!payload ||
		typeof payload !== "object" ||
		!Array.isArray((payload as { data?: unknown }).data)
	)
		throw new Error("catalog data missing");
	const rows = (payload as { data: unknown[] }).data;
	return rows.flatMap((row): OpenRouterModel[] => {
		if (!row || typeof row !== "object") return [];
		const model = row as {
			id?: unknown;
			name?: unknown;
			pricing?: Record<string, unknown>;
			architecture?: { output_modalities?: unknown };
		};
		if (typeof model.id !== "string" || !model.id) return [];
		const input = usdRate(model.pricing?.prompt);
		const output = usdRate(model.pricing?.completion);
		const request = usdRate(model.pricing?.request);
		const outputModalities = model.architecture?.output_modalities;
		const textOnlyOutput =
			Array.isArray(outputModalities) &&
			outputModalities.length === 1 &&
			outputModalities[0] === "text";
		const nonTokenCharges = Object.entries(model.pricing ?? {})
			.filter(
				([key]) =>
					key !== "prompt" && key !== "completion" && key !== "request",
			)
			.some(([, value]) => {
				const rate = usdRate(value);
				return rate === null || rate > 0;
			});
		const zeroTokenRate = input === 0 && output === 0;
		const status =
			input === null || output === null
				? "unknown"
				: zeroTokenRate &&
						!textOnlyOutput &&
						!nonTokenCharges &&
						(request === null || request === 0)
					? "unknown"
					: zeroTokenRate &&
							textOnlyOutput &&
							!nonTokenCharges &&
							(request === null || request === 0)
						? "free"
						: "priced";
		return [
			{
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				price: {
					status,
					inputUsdPerMillion: input === null ? null : input * 1_000_000,
					outputUsdPerMillion: output === null ? null : output * 1_000_000,
					requestUsd: request,
					...(zeroTokenRate && (!textOnlyOutput || nonTokenCharges)
						? { note: "Non-token charges may apply" }
						: {}),
				},
			},
		];
	});
};

export const openRouterCatalog = async (
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<OpenRouterCatalog> => {
	if (
		openRouterCache?.fetchedAt &&
		now - Date.parse(openRouterCache.fetchedAt) < OPENROUTER_CACHE_MS
	)
		return openRouterCache;
	try {
		const response = await fetcher(OPENROUTER_MODELS_URL, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
		const models = parseOpenRouterModels(await response.json());
		openRouterCache = {
			state: "catalog reachable",
			source: OPENROUTER_MODELS_URL,
			fetchedAt: new Date(now).toISOString(),
			models,
		};
		return openRouterCache;
	} catch (error) {
		return {
			state: "catalog unavailable",
			source: OPENROUTER_MODELS_URL,
			fetchedAt: openRouterCache?.fetchedAt ?? null,
			models: openRouterCache?.models ?? [],
			reason: error instanceof Error ? error.message : "catalog unavailable",
		};
	}
};

const LOCAL = (home: string) => join(home, ".claude/local-llm");
export const parseZaiAccountInventory = (
	payload: unknown,
): ZaiAccountInventory => {
	if (!payload || typeof payload !== "object")
		return {
			state: "unavailable",
			source: null,
			generatedAt: null,
			modelIds: [],
		};
	const value = payload as Record<string, unknown>;
	if (value.version !== 1 || !Array.isArray(value.model_ids))
		return {
			state: "unavailable",
			source: null,
			generatedAt: null,
			modelIds: [],
		};
	return {
		state: "available",
		source: typeof value.source === "string" ? value.source : null,
		generatedAt:
			typeof value.generated_at === "string" ? value.generated_at : null,
		modelIds: [
			...new Set(
				value.model_ids.filter(
					(id): id is string =>
						typeof id === "string" && /^glm-[a-z0-9.-]+$/.test(id),
				),
			),
		],
	};
};

const zaiAccountInventory = async (
	home: string,
): Promise<ZaiAccountInventory> => {
	try {
		return parseZaiAccountInventory(
			JSON.parse(await readFile(join(LOCAL(home), "zai-models.json"), "utf8")),
		);
	} catch {
		return {
			state: "unavailable",
			source: null,
			generatedAt: null,
			modelIds: [],
		};
	}
};
const configuredGroups = async (
	home: string,
): Promise<Map<string, string[]>> => {
	try {
		const yaml = Bun.YAML.parse(
			await Bun.file(join(LOCAL(home), "upstreams.yaml")).text(),
		) as {
			groups?: Record<string, { url?: string; model?: string }[]>;
		};
		const routes = new Map<string, string[]>();
		for (const [group, targets] of Object.entries(yaml.groups ?? {})) {
			for (const target of targets ?? []) {
				if (!target.url?.startsWith("https://api.githubcopilot.com")) continue;
				const model = target.model ?? group;
				routes.set(model, [...(routes.get(model) ?? []), group]);
			}
		}
		return routes;
	} catch {
		return new Map();
	}
};

const cliStatus = async (
	command: string[],
	positive: (output: string) => boolean,
): Promise<"signed in" | "not signed in" | "unobserved"> => {
	try {
		const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		const timeout = setTimeout(() => proc.kill(), 4000);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timeout);
		return code === 0 && positive(stdout + stderr)
			? "signed in"
			: "not signed in";
	} catch {
		return "unobserved";
	}
};

export const modelAccess = async (home: string): Promise<ModelAccess> => {
	const [groups, claude, chatgpt, openrouter, zai, zaiAccount] =
		await Promise.all([
			configuredGroups(home),
			cliStatus(
				[
					Bun.which("claude") ?? join(home, ".local/bin/claude"),
					"auth",
					"status",
					"--json",
				],
				(s) => {
					try {
						return JSON.parse(s).loggedIn === true;
					} catch {
						return false;
					}
				},
			),
			cliStatus(
				[Bun.which("codex") ?? "/opt/homebrew/bin/codex", "login", "status"],
				(s) => s.includes("Logged in"),
			),
			openRouterCatalog(),
			zaiPricing(),
			zaiAccountInventory(home),
		]);
	const result: ModelAccess = {
		ts: new Date().toISOString(),
		openrouter,
		zaiPricing: zai,
		zaiAccount,
		copilot: { state: "unconfigured", models: [] },
		personal: { claude, chatgpt },
	};
	let token: string;
	try {
		token = (await readFile(join(LOCAL(home), "copilot.key"), "utf8")).trim();
		if (!token) return result;
	} catch {
		return result;
	}
	try {
		const response = await fetch("https://api.githubcopilot.com/models", {
			headers: {
				authorization: `Bearer ${token}`,
				"copilot-integration-id": "copilot-cli",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
		const payload = (await response.json()) as {
			data?: Record<string, unknown>[];
		};
		result.copilot = {
			state: "catalog reachable",
			models: (payload.data ?? [])
				.filter(
					(row) =>
						row.model_picker_enabled === true &&
						(row.policy as { state?: string } | undefined)?.state !==
							"disabled",
				)
				.map((row) => ({
					id: String(row.id),
					name: String(row.name ?? row.id),
					vendor: String(row.vendor ?? "other"),
					endpoints: Array.isArray(row.supported_endpoints)
						? row.supported_endpoints.map(String)
						: [],
					buckle: groups.has(String(row.id)),
					routes: groups.get(String(row.id)) ?? [],
					price: {
						status: "included-unreported",
						inputUsdPerMillion: null,
						outputUsdPerMillion: null,
						requestUsd: null,
					},
				})),
		};
	} catch (error) {
		result.copilot = {
			state: "catalog unavailable",
			models: [],
			reason: error instanceof Error ? error.message : "catalog unavailable",
		};
	}
	return result;
};
