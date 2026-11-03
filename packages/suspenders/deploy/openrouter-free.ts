// OpenRouter's public catalog and account-filtered catalog jointly determine
// the free routes. The inference key resolves from the inherited env or the
// CENTRAL provider profile (W1124.8.4) and is never stored in the snapshot.
// Buckle forwards through the owned LiteLLM engine.
import {
	existsSync,
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	PROVIDER_STACK_PATH,
	loadProviderConfig,
	profileForEnv,
} from "@klh/speedy/src/provider-config.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

export const OPENROUTER_CATALOG_URL =
	"https://openrouter.ai/api/v1/models?output_modalities=all";
export const OPENROUTER_ACCOUNT_CATALOG_URL =
	"https://openrouter.ai/api/v1/models/user";
export const OPENROUTER_FREE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const ZERO_PRICE = /^0(?:\.0+)?$/;
const FREE_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*:free$/i;
export const supportedFreeId = (id: string): boolean =>
	FREE_ID.test(id) || id === "openrouter/free";
export const groupForId = (id: string): string =>
	id === "openrouter/free" ? id : `openrouter/${id}`;

type CatalogModel = {
	id?: unknown;
	architecture?: {
		input_modalities?: unknown;
		output_modalities?: unknown;
		modality?: unknown;
	};
	pricing?: Record<string, unknown>;
};

export type FreeRoute = {
	url: string;
	dialect: "openai";
	adapter: "openai-compat";
	api_key_env: "LITELLM_KEY";
	/** W1094.1: generated rows ride the LiteLLM engine — declare it so Buckle
	 * applies bounded proxy behavior (zero inner retries, bounded first-byte
	 * headers) and route preflight validates the hop (zai-catalog parity). */
	adapter_config: { proxy_kind: "litellm" };
	model: string;
};

export type FreeSnapshot = {
	version: 1;
	source: typeof OPENROUTER_CATALOG_URL;
	account_source: typeof OPENROUTER_ACCOUNT_CATALOG_URL;
	generated_at: string;
	public_model_count: number;
	account_model_count: number;
	groups: Record<string, FreeRoute[]>;
	excluded_free_models: Array<{ id: string; reason: string }>;
};

const routeForId = (id: string): FreeRoute => ({
	url: "http://127.0.0.1:4100",
	dialect: "openai",
	adapter: "openai-compat",
	api_key_env: "LITELLM_KEY",
	adapter_config: { proxy_kind: "litellm" },
	model: groupForId(id),
});

// W2546.2 root review (#102805): strict, FIELD-based route validation —
// JSON.stringify equality rejected byte-equivalent snapshots whose route
// objects listed properties in a different order. strict() rejects added
// fields; the literals pin dialect/adapter/key/proxy; url+model equality
// pins the rest. Property order never matters.
const FreeRouteSchema = z
	.object({
		url: z.string(),
		dialect: z.literal("openai"),
		adapter: z.literal("openai-compat"),
		api_key_env: z.literal("LITELLM_KEY"),
		adapter_config: z.object({ proxy_kind: z.literal("litellm") }).strict(),
		model: z.string(),
	})
	.strict();
const RouteListSchema = z.array(FreeRouteSchema).length(1);

/** A snapshot group entry the generator would never emit itself. */
const routeInvalid = (group: string, deployments: unknown): boolean => {
	const id =
		group === "openrouter/free" ? group : group.slice("openrouter/".length);
	if (group !== groupForId(id) || !supportedFreeId(id)) return true;
	const parsed = RouteListSchema.safeParse(deployments);
	if (!parsed.success) return true;
	const [route] = parsed.data;
	if (!route) return true;
	const expected = routeForId(id);
	return route.url !== expected.url || route.model !== expected.model;
};

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
		if (
			typeof model?.id !== "string" ||
			!(model.id.endsWith(":free") || model.id === "openrouter/free")
		)
			continue;
		const price = model.pricing;
		const extraFee = Object.entries(price ?? {}).find(
			([key, value]) =>
				key !== "prompt" &&
				key !== "completion" &&
				key !== "request" &&
				!(typeof value === "string" && ZERO_PRICE.test(value)),
		);
		const reason = !supportedFreeId(model.id)
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
						: extraFee
							? `${extraFee[0]} fee is nonzero or unreported`
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
	accountCatalog: unknown = catalog,
): FreeSnapshot {
	const { ids: publicIds, excluded } = classifyFreeModels(catalog);
	const accountIds = new Set(eligibleFreeModelIds(accountCatalog));
	const ids = publicIds.filter((id) => accountIds.has(id));
	for (const id of publicIds)
		if (!accountIds.has(id))
			excluded.push({
				id,
				reason:
					"excluded by account privacy, provider preferences, or guardrails",
			});
	if (publicIds.length === 0)
		throw new Error(
			"OpenRouter catalog has no eligible free text models; retaining the previous snapshot",
		);
	return {
		version: 1,
		source: OPENROUTER_CATALOG_URL,
		account_source: OPENROUTER_ACCOUNT_CATALOG_URL,
		generated_at: now.toISOString(),
		public_model_count: (catalog as { data: unknown[] }).data.length,
		account_model_count: (accountCatalog as { data: unknown[] }).data.length,
		groups: Object.fromEntries(
			ids.map((id) => [groupForId(id), [routeForId(id)]]),
		),
		excluded_free_models: excluded.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

/** W1124.8.4: the OpenRouter inference key resolves from the inherited env
 *  or the CENTRAL provider profile bound to OPENROUTER_API_KEY (env NAME,
 *  never a path convention). A missing binding names the migration — this
 *  is the explicit-CLI-only legacy read surface. */
export const readInferenceKey = (
	stackPath: string = PROVIDER_STACK_PATH(),
): string => {
	if (process.env.OPENROUTER_API_KEY?.trim())
		return process.env.OPENROUTER_API_KEY.trim();
	const profile = profileForEnv(
		"OPENROUTER_API_KEY",
		loadProviderConfig(stackPath),
	);
	if (profile?.key) return profile.key;
	throw new Error(
		"OpenRouter inference key: set OPENROUTER_API_KEY in the environment or a provider profile (stack.json providers, env: OPENROUTER_API_KEY)",
	);
};

const readBoundedCatalog = async (
	response: Response,
	label: string,
): Promise<unknown> => {
	if (!response.ok || !response.body)
		throw new Error(`${label} HTTP ${response.status}`);
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
	return JSON.parse(new TextDecoder().decode(joined));
};

export async function fetchFreeSnapshot(
	fetcher: typeof fetch = fetch,
	inferenceKey = readInferenceKey(),
): Promise<FreeSnapshot> {
	const [publicResponse, accountResponse] = await Promise.all([
		fetcher(OPENROUTER_CATALOG_URL, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		}),
		fetcher(OPENROUTER_ACCOUNT_CATALOG_URL, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${inferenceKey}`,
			},
			signal: AbortSignal.timeout(10_000),
		}),
	]);
	const [catalog, accountCatalog] = await Promise.all([
		readBoundedCatalog(publicResponse, "OpenRouter public catalog"),
		readBoundedCatalog(accountResponse, "OpenRouter account catalog"),
	]);
	return snapshotFromCatalog(catalog, new Date(), accountCatalog);
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

// ─── stale-snapshot preflight (W2546.2) ───
// Mirror of the Z.ai preflight (deploy/zai-catalog.ts refreshStaleZaiSnapshot,
// W1469): a snapshot whose only defect is age is revalidated against the live
// public+account catalogs and refreshed in place when the route groups are
// byte-identical — the timestamp repair the 2026-11-02 seedLocalLlm failure
// needed. A real group change, a bad key, or a network failure NEVER writes.

const invalidSnapshotMessage = "invalid OpenRouter free catalog snapshot";

// W2546.2 schema law (W1238.4): the snapshot on disk is a config-file boundary
// — a named Zod schema safeParse's it, never a hand cast. Proven rejects:
// arrays-as-groups, null, unparseable timestamps, wrong version/source.
export const FreeSnapshotShapeSchema = z.object({
	version: z.literal(1),
	source: z.literal(OPENROUTER_CATALOG_URL),
	account_source: z.literal(OPENROUTER_ACCOUNT_CATALOG_URL),
	generated_at: z
		.string()
		.refine(
			(s) => Number.isFinite(Date.parse(s)),
			"generated_at is not a parseable timestamp",
		),
	public_model_count: z.number(),
	account_model_count: z.number(),
	excluded_free_models: z.array(
		z.object({ id: z.string(), reason: z.string() }).loose(),
	),
	groups: z.record(z.string(), RouteListSchema),
});
export type FreeSnapshotShape = z.infer<typeof FreeSnapshotShapeSchema>;

export class OpenRouterSnapshotStaleError extends Error {
	constructor(readonly snapshot: FreeSnapshot) {
		super("OpenRouter free catalog snapshot is stale");
		this.name = "OpenRouterSnapshotStaleError";
	}
}

/** Throws only `OpenRouterSnapshotStaleError` for an otherwise-valid-but-old
 *  snapshot; rethrows parse/shape errors as Error for a bounded diagnostic.
 *  null = no snapshot at all (the generator's rows stay empty without a key). */
export function readStaleFreeSnapshot(
	path: string,
	now = Date.now(),
): FreeSnapshot | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(invalidSnapshotMessage);
	}
	const parsed = FreeSnapshotShapeSchema.safeParse(raw);
	if (!parsed.success) throw new Error(invalidSnapshotMessage);
	const doc: FreeSnapshot = parsed.data;
	for (const [group, deployments] of Object.entries(doc.groups)) {
		if (routeInvalid(group, deployments))
			throw new Error(
				`invalid OpenRouter free catalog route: ${sanitizeRouteGroup(group)}`,
			);
	}
	const age = now - Date.parse(doc.generated_at);
	if (age < 0) throw new Error(invalidSnapshotMessage);
	if (age <= OPENROUTER_FREE_MAX_AGE_MS) return doc;
	throw new OpenRouterSnapshotStaleError(doc);
}

/** Route-group names for diagnostics — the snapshot's own field names, never
 *  file bytes (unbounded) and never key material. */
export const sanitizeRouteGroup = (group: string): string =>
	group.replace(/[^\w./:-]+/g, "_").slice(0, 120);

export type OpenRouterStaleResult =
	| { kind: "refreshed"; groups: number }
	| { kind: "delta"; added: string[]; removed: string[] }
	| { kind: "failed"; why: string };

/** Timestamp-only stale snapshot: refresh in place only when the live public
 *  catalog yields identical route groups. `fetchFreeSnapshot` intersects the
 *  public catalog with the ACCOUNT catalog, so identical groups already prove
 *  account eligibility — a revoked id drops out of `live.groups` and lands in
 *  `removed` (blocked, never silently accepted). Fresh/absent snapshots cost
 *  no key read and no network. Never names the key itself. */
export async function refreshStaleOpenRouterSnapshot(
	path: string,
	fetcher: typeof fetch = fetch,
	inferenceKey: () => string = readInferenceKey,
): Promise<OpenRouterStaleResult | null> {
	let stale: FreeSnapshot;
	try {
		const doc = readStaleFreeSnapshot(path);
		if (doc !== null) return null; // fresh — nothing to repair
		return null; // absent — the generator emits no rows without a snapshot
	} catch (error) {
		if (!(error instanceof OpenRouterSnapshotStaleError))
			return {
				kind: "failed",
				why: error instanceof Error ? error.message : String(error),
			};
		stale = error.snapshot;
	}
	try {
		const live = await fetchFreeSnapshot(fetcher, inferenceKey());
		const added = Object.keys(live.groups).filter((g) => !(g in stale.groups));
		const removed = Object.keys(stale.groups).filter(
			(g) => !(g in live.groups),
		);
		if (added.length > 0 || removed.length > 0)
			return { kind: "delta", added, removed };
		writeFreeSnapshot(path, live);
		return { kind: "refreshed", groups: Object.keys(live.groups).length };
	} catch (error) {
		return {
			kind: "failed",
			why: error instanceof Error ? error.message : String(error),
		};
	}
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
		doc.account_source !== OPENROUTER_ACCOUNT_CATALOG_URL ||
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
		if (routeInvalid(group, deployments))
			throw new Error("invalid OpenRouter free catalog route");
	}
	return { ...doc.groups, ...explicit };
}
