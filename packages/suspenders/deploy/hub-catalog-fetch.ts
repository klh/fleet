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
import { readBoundedJson, readPrivateKey } from "./catalog-http.ts";

export type CatalogKind = "copilot" | "zai" | "openai";
export type Unverifiable = "no-catalog" | "no-credential" | "credential-on-device";
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

const copilotHeaders = (row: Record<string, unknown>): Record<string, string> => {
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
const catalogRows = (kind: CatalogKind, body: unknown): Map<string, unknown> => {
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
		return failed("credential-missing", target.source, "key file missing, empty or not 0600");
	}
	let response: Response;
	try {
		response = await fetcher(target.source, {
			headers: { ...target.headers, accept: "application/json", authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return failed("provider-failure", target.source, "request failed or timed out");
	}
	if (response.status === 401 || response.status === 403)
		return failed("credential-rejected", target.source, `HTTP ${response.status}`);
	if (!response.ok)
		return failed("provider-failure", target.source, `HTTP ${response.status}`);
	let rows: Map<string, unknown>;
	try {
		rows = catalogRows(target.kind, await readBoundedJson(response, "catalog"));
	} catch (error) {
		const oversize = error instanceof Error && error.message.endsWith("exceeds 1 MiB");
		return failed("provider-failure", target.source, oversize ? "catalog exceeds 1 MiB" : "catalog body unreadable");
	}
	if (!rows.size)
		return failed("provider-failure", target.source, "catalog lists no models");
	const observedAt = new Date().toISOString();
	return { state: "listed", kind: target.kind, source: target.source, observedAt, rows };
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
