// Authenticated live catalogs for configured hub upstream rows. A provider
// listing is the only availability evidence: config rows, health probes and
// minimal 200s never count. Keys stay in this module; results carry fixed
// failure text and HTTP status only.
import {
	COPILOT_CATALOG_URL,
	fromCopilotCatalogRow,
	type ModelCapabilityRecord,
} from "@klh/belt/bin/model-capabilities.ts";
import {
	parseZaiModelIds,
	ZAI_CATALOG_URL,
} from "@klh/belt/bin/zai-catalog-rows.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import {
	readBoundedJson,
	readPrivateKey,
	catalogResponse,
} from "./catalog-http.ts";

export type CatalogKind = "copilot" | "zai" | "openai";
export type Unverifiable =
	| "no-catalog"
	| "no-credential"
	| "credential-on-device";
export type ListingFailure =
	| "credential-missing"
	| "credential-rejected"
	| "provider-failure";

export type CatalogTarget =
	| {
			kind: CatalogKind;
			source: string;
			keyFile: string;
			headers: Record<string, string>;
	  }
	| { kind: "unverifiable"; reason: Unverifiable };

export type CatalogListing =
	| {
			state: "listed";
			kind: CatalogKind;
			source: string;
			observedAt: string;
			rows: Map<string, unknown>;
	  }
	| { state: ListingFailure; source: string; detail: string };

const parsedUrl = (value: unknown): URL | null => {
	if (typeof value !== "string") return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
};

const copilotHeaders = (
	row: Record<string, unknown>,
): Record<string, string> => {
	const config = row.adapter_config as Record<string, unknown> | undefined;
	const headers = config?.headers as Record<string, unknown> | undefined;
	const id = headers?.["copilot-integration-id"];
	return typeof id === "string" ? { "copilot-integration-id": id } : {};
};

/** Which authenticated listing can prove this row; remote hubs keep keys on-device. */
export function catalogTarget(
	hub: HubProfile,
	row: Record<string, unknown>,
): CatalogTarget {
	const url = parsedUrl(row.url);
	const kind: CatalogKind | null =
		url?.hostname === "api.githubcopilot.com"
			? "copilot"
			: url?.hostname === "api.z.ai"
				? "zai"
				: row.dialect === "openai"
					? "openai"
					: null;
	if (!url || !kind) return { kind: "unverifiable", reason: "no-catalog" };
	const env = typeof row.api_key_env === "string" ? row.api_key_env : "";
	const keyFile = env ? hub.secrets?.upstream_keys?.[env] : undefined;
	if (!keyFile) return { kind: "unverifiable", reason: "no-credential" };
	if (hub.deploy?.ssh)
		return { kind: "unverifiable", reason: "credential-on-device" };
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
	const source =
		kind === "copilot"
			? COPILOT_CATALOG_URL
			: kind === "zai"
				? ZAI_CATALOG_URL
				: `${base}/v1/models`;
	const headers = kind === "copilot" ? copilotHeaders(row) : {};
	return { kind, source, keyFile, headers };
}

/** Listed ids keyed to their raw rows (Z.ai rows are ids only). */
const catalogRows = (
	kind: CatalogKind,
	body: unknown,
): Map<string, unknown> => {
	if (kind === "zai") {
		const ids = parseZaiModelIds(body);
		return new Map(
			[...ids.model_ids, ...ids.excluded_model_ids].map((id) => [id, null]),
		);
	}
	const data = (body as { data?: unknown } | null)?.data;
	const rows = new Map<string, unknown>();
	for (const row of Array.isArray(data) ? data : [])
		if (typeof row?.id === "string" && row.id) rows.set(row.id, row);
	return rows;
};

const failed = (
	state: ListingFailure,
	source: string,
	detail: string,
): CatalogListing => ({ state, source, detail });

/** One authenticated GET; 401/403 is a credential verdict, never a stale row. */
export async function fetchCatalog(
	target: Extract<CatalogTarget, { keyFile: string }>,
	fetcher: typeof fetch = fetch,
): Promise<CatalogListing> {
	let key: string;
	try {
		key = readPrivateKey(target.keyFile, "catalog");
	} catch {
		return failed(
			"credential-missing",
			target.source,
			"key file missing, empty or not 0600",
		);
	}
	return fetchCatalogWithKey(target, key, fetcher);
}

/** Canonical credentials stay in memory; no credential-bearing catalog output. */
export async function fetchCatalogWithKey(
	target: {
		kind: CatalogKind;
		source: string;
		headers: Record<string, string>;
		auth?: "anthropic";
		maxBytes?: number;
	},
	key: string | undefined,
	fetcher: typeof fetch = fetch,
	timeoutMs = 10_000,
): Promise<CatalogListing> {
	const signal = AbortSignal.timeout(timeoutMs);
	const init: RequestInit = {
		headers: {
			...target.headers,
			accept: "application/json",
			...(key
				? target.auth === "anthropic"
					? { "x-api-key": key, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${key}` }
				: {}),
		},
		redirect: "error",
	};
	let response: Response;
	try {
		response = await catalogResponse(target.source, init, signal, fetcher);
	} catch {
		return failed(
			"provider-failure",
			target.source,
			"request failed or timed out",
		);
	}
	if (!response.ok) void response.body?.cancel().catch(() => {});
	if (response.status === 401 || response.status === 403)
		return failed(
			"credential-rejected",
			target.source,
			`HTTP ${response.status}`,
		);
	if (!response.ok)
		return failed("provider-failure", target.source, `HTTP ${response.status}`);
	let rows: Map<string, unknown>;
	try {
		const limit = target.maxBytes ?? 1024 * 1024;
		const budget = { remaining: limit, limit };
		rows = new Map();
		const cursors = new Set<string>();
		for (let page = 0; ; page++) {
			const body = (await readBoundedJson(
				response,
				"catalog",
				signal,
				budget,
			)) as { has_more?: unknown; last_id?: unknown };
			for (const [id, row] of catalogRows(target.kind, body)) {
				if (
					id.length > 512 ||
					[...id].some(
						(character) =>
							character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
					)
				)
					continue;
				rows.set(id, row);
			}
			if (rows.size > 4096) throw new Error("catalog exceeds model limit");
			if (body.has_more !== true) break;
			if (
				page >= 63 ||
				typeof body.last_id !== "string" ||
				!body.last_id ||
				cursors.has(body.last_id)
			)
				throw new Error("catalog pagination refused");
			cursors.add(body.last_id);
			const next = new URL(target.source);
			next.searchParams.set("after_id", body.last_id);
			response = await catalogResponse(next.toString(), init, signal, fetcher);
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new Error("catalog page failed");
			}
		}
	} catch (error) {
		const oversize =
			error instanceof Error && error.message.includes(" exceeds ");
		return failed(
			"provider-failure",
			target.source,
			error instanceof Error && error.message === "catalog exceeds 1 MiB"
				? "catalog exceeds 1 MiB"
				: oversize
					? "catalog exceeds byte or model budget"
					: "catalog body unreadable",
		);
	}
	if (!rows.size)
		return failed("provider-failure", target.source, "catalog lists no models");
	const observedAt = new Date().toISOString();
	return {
		state: "listed",
		kind: target.kind,
		source: target.source,
		observedAt,
		rows,
	};
}

export type Listed = Extract<CatalogListing, { state: "listed" }>;

/** Registry record for a listed model; only Copilot publishes endpoints and limits. */
export const listedCapability = (
	listing: Listed,
	model: string,
): ModelCapabilityRecord | null =>
	listing.kind === "copilot"
		? fromCopilotCatalogRow(listing.rows.get(model), listing.observedAt)
		: null;
