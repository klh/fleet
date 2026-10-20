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

export interface ModelAccess {
	ts: string;
	openrouter: OpenRouterCatalog;
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
		};
		if (typeof model.id !== "string" || !model.id) return [];
		const input = usdRate(model.pricing?.prompt);
		const output = usdRate(model.pricing?.completion);
		const request = usdRate(model.pricing?.request);
		const status =
			input === null || output === null
				? "unknown"
				: input === 0 && output === 0 && (request === null || request === 0)
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
	const [groups, claude, chatgpt, openrouter] = await Promise.all([
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
	]);
	const result: ModelAccess = {
		ts: new Date().toISOString(),
		openrouter,
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
