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
}

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

const fact = <T>(
	value: T | null,
	source: string,
	observedAt: string,
): CapabilityFact<T> => ({ value, source, observedAt });

const unknown = <T>(): CapabilityFact<T> => ({ ...UNKNOWN });

const positiveInteger = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;

const stringArray = (value: unknown): string[] | null =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((item) => typeof item === "string" && item.length > 0)
		? [...new Set(value)]
		: null;

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const validObservedAt = (value: string): boolean =>
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

const fresh = <T>(
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
});

const key = (provider: string, modelId: string): string =>
	JSON.stringify([provider, modelId]);

const newerFact = <T>(
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
		for (const record of records) this.upsert(record);
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

const validRecord = (value: unknown): value is ModelCapabilityRecord => {
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
		validFact(row.cost, validPrice)
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
