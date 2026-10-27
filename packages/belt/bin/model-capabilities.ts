// Sourced model facts for route selection. An absent or expired fact is unknown.
// Model identity is the exact provider + model ID pair; names are never joined.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelPrice } from "./model-access.ts";

export interface CapabilityFact<T> {
	value: T | null;
	source: string | null;
	observedAt: string | null;
}

export interface ModelCapabilityRecord {
	provider: string;
	modelId: string;
	locality: CapabilityFact<"local" | "remote">;
	inputModalities: CapabilityFact<string[]>;
	outputModalities: CapabilityFact<string[]>;
	contextTokens: CapabilityFact<number>;
	maxOutputTokens: CapabilityFact<number>;
	tools: CapabilityFact<boolean>;
	structuredOutput: CapabilityFact<boolean>;
	cost: CapabilityFact<ModelPrice>;
	/** Published provider endpoints; older snapshots without it read unknown. */
	endpoints: CapabilityFact<WireEndpoint[]>;
	streaming: CapabilityFact<boolean>;
}

/** The closed wire vocabulary dispatch reads (W1711 persists, W1712 reads). */
export type WireEndpoint =
	| "/v1/messages"
	| "/v1/chat/completions"
	| "/v1/responses";

export interface CapabilitySnapshot {
	version: 1;
	savedAt: string;
	records: ModelCapabilityRecord[];
}

export const defaultCapabilitySnapshotPath = (): string =>
	join(homedir(), ".claude", "local-llm", "model-capabilities.json");

const UNKNOWN: CapabilityFact<never> = {
	value: null,
	source: null,
	observedAt: null,
};

export const fact = <T>(
	value: T | null,
	source: string,
	observedAt: string,
): CapabilityFact<T> => ({ value, source, observedAt });

export const unknown = <T>(): CapabilityFact<T> => ({ ...UNKNOWN });

export const positiveInteger = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;

const stringArray = (value: unknown): string[] | null =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((item) => typeof item === "string" && item.length > 0)
		? [...new Set(value)]
		: null;

// Provider endpoint spellings onto the closed wire vocabulary.
const WIRE_PATHS = new Map<string, WireEndpoint>([
	["/v1/messages", "/v1/messages"],
	["/chat/completions", "/v1/chat/completions"],
	["/v1/chat/completions", "/v1/chat/completions"],
	["/responses", "/v1/responses"],
	["/v1/responses", "/v1/responses"],
]);

/** Normalized published endpoints; unrecognized paths drop, none = unknown. */
export const wireEndpoints = (value: unknown): WireEndpoint[] | null => {
	const paths = (stringArray(value) ?? []).flatMap((path) => {
		const endpoint = WIRE_PATHS.get(path);
		return endpoint ? [endpoint] : [];
	});
	return paths.length ? [...new Set(paths)] : null;
};

const isWireList = (value: unknown): boolean =>
	stringArray(value)?.every((path) => WIRE_PATHS.get(path) === path) === true;

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

export const validObservedAt = (value: string): boolean =>
	Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const emptyCapability = (
	provider: string,
	modelId: string,
): ModelCapabilityRecord => ({
	provider,
	modelId,
	locality: unknown(),
	inputModalities: unknown(),
	outputModalities: unknown(),
	contextTokens: unknown(),
	maxOutputTokens: unknown(),
	tools: unknown(),
	structuredOutput: unknown(),
	cost: unknown(),
	endpoints: unknown(),
	streaming: unknown(),
});

/** Raw OpenRouter catalog row, captured from /api/v1/models (not /models/user). */
export const fromOpenRouterCatalogRow = (
	value: unknown,
	observedAt: string,
	cost?: { modelId: string; fact: CapabilityFact<ModelPrice> },
): ModelCapabilityRecord | null => {
	const row = object(value);
	if (
		!row ||
		typeof row.id !== "string" ||
		!row.id ||
		!validObservedAt(observedAt)
	)
		return null;
	const record = emptyCapability("openrouter", row.id);
	const source = "https://openrouter.ai/api/v1/models";
	const architecture = object(row.architecture);
	const topProvider = object(row.top_provider);
	const parameters = stringArray(row.supported_parameters);
	record.locality = fact("remote", source, observedAt);
	record.inputModalities = fact(
		stringArray(architecture?.input_modalities),
		source,
		observedAt,
	);
	record.outputModalities = fact(
		stringArray(architecture?.output_modalities),
		source,
		observedAt,
	);
	record.contextTokens = fact(
		positiveInteger(topProvider?.context_length) ??
			positiveInteger(row.context_length),
		source,
		observedAt,
	);
	record.maxOutputTokens = fact(
		positiveInteger(topProvider?.max_completion_tokens),
		source,
		observedAt,
	);
	// Missing parameters do not establish lack of feature support.
	record.tools = fact(
		parameters?.includes("tools") ? true : null,
		source,
		observedAt,
	);
	record.structuredOutput = fact(
		parameters?.includes("structured_outputs") ? true : null,
		source,
		observedAt,
	);
	if (
		cost?.modelId === row.id &&
		cost.fact.source === source &&
		cost.fact.observedAt === observedAt
	)
		record.cost = cost.fact;
	return record;
};

/** A local serving window is sourced from the Belt specialist registry. */
export const fromLocalSpecialist = (
	entry: { model: string; contextTokens: number },
	observedAt: string,
): ModelCapabilityRecord | null => {
	if (!entry.model || !validObservedAt(observedAt)) return null;
	const source = "belt:registry";
	const record = emptyCapability("belt-local", entry.model);
	record.locality = fact("local", source, observedAt);
	record.contextTokens = fact(
		positiveInteger(entry.contextTokens),
		source,
		observedAt,
	);
	record.cost = fact(
		{
			status: "local-unpriced",
			inputUsdPerMillion: null,
			outputUsdPerMillion: null,
			requestUsd: null,
		},
		source,
		observedAt,
	);
	return record;
};

/** Catalog identity and locality can be known while all other fields remain unknown. */
export const fromRemoteCatalogId = (
	provider: string,
	modelId: string,
	source: string,
	observedAt: string,
): ModelCapabilityRecord | null => {
	if (!provider || !modelId || !source || !validObservedAt(observedAt))
		return null;
	const record = emptyCapability(provider, modelId);
	record.locality = fact("remote", source, observedAt);
	return record;
};

export const COPILOT_CATALOG_URL = "https://api.githubcopilot.com/models";

/** Raw Copilot catalog row: supported_endpoints plus published limits. */
export const fromCopilotCatalogRow = (
	value: unknown,
	observedAt: string,
): ModelCapabilityRecord | null => {
	const row = object(value);
	if (!row || typeof row.id !== "string" || !row.id) return null;
	const record = fromRemoteCatalogId(
		"copilot",
		row.id,
		COPILOT_CATALOG_URL,
		observedAt,
	);
	if (!record) return null;
	const capabilities = object(row.capabilities);
	const limits = object(capabilities?.limits);
	const supports = object(capabilities?.supports);
	const published = <T>(value: T | null) =>
		fact(value, COPILOT_CATALOG_URL, observedAt);
	const flag = (name: string): boolean | null => {
		const value = supports?.[name];
		return typeof value === "boolean" ? value : null;
	};
	record.contextTokens = published(
		positiveInteger(limits?.max_context_window_tokens),
	);
	record.maxOutputTokens = published(positiveInteger(limits?.max_output_tokens));
	record.tools = published(flag("tool_calls"));
	record.structuredOutput = published(flag("structured_outputs"));
	record.streaming = published(flag("streaming"));
	record.endpoints = published(wireEndpoints(row.supported_endpoints));
	return record;
};

export const fresh = <T>(
	field: CapabilityFact<T>,
	maxAgeMs: number,
	now: number,
	sourceMaxAgeMs?: ReadonlyMap<string, number>,
): CapabilityFact<T> => {
	const observed = field.observedAt ? Date.parse(field.observedAt) : NaN;
	const allowedAge = sourceMaxAgeMs?.get(field.source ?? "") ?? maxAgeMs;
	return field.value !== null &&
		Number.isFinite(observed) &&
		observed <= now &&
		now - observed <= allowedAge
		? field
		: { ...field, value: null };
};

/** Preserve provenance when a fact expires, but never expose its old value. */
export const currentCapability = (
	record: ModelCapabilityRecord,
	maxAgeMs: number,
	now = Date.now(),
	sourceMaxAgeMs?: ReadonlyMap<string, number>,
): ModelCapabilityRecord => ({
	...record,
	locality: fresh(record.locality, maxAgeMs, now, sourceMaxAgeMs),
	inputModalities: fresh(record.inputModalities, maxAgeMs, now, sourceMaxAgeMs),
	outputModalities: fresh(
		record.outputModalities,
		maxAgeMs,
		now,
		sourceMaxAgeMs,
	),
	contextTokens: fresh(record.contextTokens, maxAgeMs, now, sourceMaxAgeMs),
	maxOutputTokens: fresh(record.maxOutputTokens, maxAgeMs, now, sourceMaxAgeMs),
	tools: fresh(record.tools, maxAgeMs, now, sourceMaxAgeMs),
	structuredOutput: fresh(
		record.structuredOutput,
		maxAgeMs,
		now,
		sourceMaxAgeMs,
	),
	cost: fresh(record.cost, maxAgeMs, now, sourceMaxAgeMs),
	endpoints: fresh(record.endpoints, maxAgeMs, now, sourceMaxAgeMs),
	streaming: fresh(record.streaming, maxAgeMs, now, sourceMaxAgeMs),
});

const key = (provider: string, modelId: string): string =>
	JSON.stringify([provider, modelId]);

export const newerFact = <T>(
	previous: CapabilityFact<T>,
	next: CapabilityFact<T>,
): CapabilityFact<T> => {
	if (next.value === null) return previous.value === null ? next : previous;
	if (previous.value === null) return next;
	return Date.parse(next.observedAt ?? "") >=
		Date.parse(previous.observedAt ?? "")
		? next
		: previous;
};

export class CapabilityRegistry {
	private readonly records = new Map<string, ModelCapabilityRecord>();

	constructor(records: ModelCapabilityRecord[] = []) {
		// Snapshots written before a field existed load it as unknown.
		for (const record of records)
			this.upsert({
				...emptyCapability(record.provider, record.modelId),
				...record,
			});
	}

	upsert(
		record: ModelCapabilityRecord,
		options: { preferLocality?: boolean } = {},
	): void {
		if (!record.provider || !record.modelId)
			throw new Error("provider and modelId are required");
		const previous = this.records.get(key(record.provider, record.modelId));
		const merged = previous
			? {
					...record,
					locality: options.preferLocality
						? record.locality
						: newerFact(previous.locality, record.locality),
					inputModalities: newerFact(
						previous.inputModalities,
						record.inputModalities,
					),
					outputModalities: newerFact(
						previous.outputModalities,
						record.outputModalities,
					),
					contextTokens: newerFact(
						previous.contextTokens,
						record.contextTokens,
					),
					maxOutputTokens: newerFact(
						previous.maxOutputTokens,
						record.maxOutputTokens,
					),
					tools: newerFact(previous.tools, record.tools),
					structuredOutput: newerFact(
						previous.structuredOutput,
						record.structuredOutput,
					),
					cost: newerFact(previous.cost, record.cost),
					endpoints: newerFact(previous.endpoints, record.endpoints),
					streaming: newerFact(previous.streaming, record.streaming),
				}
			: record;
		this.records.set(
			key(record.provider, record.modelId),
			structuredClone(merged),
		);
	}

	get(
		provider: string,
		modelId: string,
		maxAgeMs: number,
		now = Date.now(),
	): ModelCapabilityRecord | null {
		const record = this.records.get(key(provider, modelId));
		return record
			? currentCapability(structuredClone(record), maxAgeMs, now)
			: null;
	}

	all(): ModelCapabilityRecord[] {
		return [...this.records.values()].map((record) => structuredClone(record));
	}
}

const PROVIDER_HOSTS = new Map([
	["api.githubcopilot.com", "copilot"],
	["api.z.ai", "zai"],
	["openrouter.ai", "openrouter"],
]);

/** Registry provider for a deployment URL: catalog providers by name, else host. */
export const capabilityProvider = (url: unknown): string | null => {
	if (typeof url !== "string") return null;
	try {
		const host = new URL(url).hostname;
		return PROVIDER_HOSTS.get(host) ?? host;
	} catch {
		return null;
	}
};

/** The one group join: the known endpoint union, null when any row is unknown. */
export const groupWireEndpoints = (
	rows: ReadonlyArray<Record<string, unknown>>,
	registry: CapabilityRegistry,
	maxAgeMs: number,
	now = Date.now(),
): WireEndpoint[] | null => {
	const union = new Set<WireEndpoint>();
	for (const row of rows) {
		const provider = capabilityProvider(row.url);
		const known =
			provider && typeof row.model === "string"
				? registry.get(provider, row.model, maxAgeMs, now)?.endpoints.value
				: null;
		if (!known) return null;
		for (const endpoint of known) union.add(endpoint);
	}
	return union.size ? [...union] : null;
};

const validFact = (
	value: unknown,
	validValue: (value: unknown) => boolean,
): boolean => {
	const field = object(value);
	return (
		!!field &&
		(field.value === null || validValue(field.value)) &&
		(field.source === null || typeof field.source === "string") &&
		(field.observedAt === null ||
			(typeof field.observedAt === "string" &&
				validObservedAt(field.observedAt)))
	);
};

const validPrice = (value: unknown): boolean => {
	const price = object(value);
	return (
		!!price &&
		[
			"free",
			"priced",
			"included-unreported",
			"local-unpriced",
			"unknown",
		].includes(String(price.status)) &&
		["inputUsdPerMillion", "outputUsdPerMillion", "requestUsd"].every(
			(field) =>
				price[field] === null ||
				(typeof price[field] === "number" &&
					Number.isFinite(price[field]) &&
					price[field] >= 0),
		)
	);
};

/** Snapshot row shape check; reviewed plans reuse it before any write. */
export const validRecord = (value: unknown): value is ModelCapabilityRecord => {
	const row = object(value);
	return (
		!!row &&
		typeof row.provider === "string" &&
		!!row.provider &&
		typeof row.modelId === "string" &&
		!!row.modelId &&
		validFact(row.locality, (v) => v === "local" || v === "remote") &&
		validFact(row.inputModalities, (v) => stringArray(v) !== null) &&
		validFact(row.outputModalities, (v) => stringArray(v) !== null) &&
		validFact(row.contextTokens, (v) => positiveInteger(v) !== null) &&
		validFact(row.maxOutputTokens, (v) => positiveInteger(v) !== null) &&
		validFact(row.tools, (v) => typeof v === "boolean") &&
		validFact(row.structuredOutput, (v) => typeof v === "boolean") &&
		validFact(row.cost, validPrice) &&
		(row.endpoints === undefined || validFact(row.endpoints, isWireList)) &&
		(row.streaming === undefined ||
			validFact(row.streaming, (v) => typeof v === "boolean"))
	);
};

export const writeCapabilitySnapshot = async (
	path: string,
	registry: CapabilityRegistry,
	now = Date.now(),
): Promise<void> => {
	const snapshot: CapabilitySnapshot = {
		version: 1,
		savedAt: new Date(now).toISOString(),
		records: registry.all(),
	};
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(snapshot));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
};

export const readCapabilitySnapshot = async (
	path: string,
): Promise<
	| { state: "available"; savedAt: string; registry: CapabilityRegistry }
	| { state: "missing" | "invalid"; registry: CapabilityRegistry }
> => {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { state: "missing", registry: new CapabilityRegistry() };
		throw error;
	}
	try {
		const snapshot = object(JSON.parse(text));
		if (
			snapshot?.version !== 1 ||
			typeof snapshot.savedAt !== "string" ||
			!validObservedAt(snapshot.savedAt) ||
			!Array.isArray(snapshot.records) ||
			!snapshot.records.every(validRecord)
		)
			return { state: "invalid", registry: new CapabilityRegistry() };
		return {
			state: "available",
			savedAt: snapshot.savedAt,
			registry: new CapabilityRegistry(snapshot.records),
		};
	} catch {
		return { state: "invalid", registry: new CapabilityRegistry() };
	}
};
