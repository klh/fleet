// Measured route performance facts for selection. Sourced ONLY from belt's
// own metrics.db endpoint tallies — never fabricated, never probed on demand.
// An absent or expired fact is unknown. Mirror of model-capabilities.ts:
// provenance rides every fact; freshness is applied at read time.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { metricsSnapshot, type EndpointMetrics } from "./metrics.ts";
import {
	fact,
	fresh,
	newerFact,
	positiveInteger,
	validObservedAt,
	type CapabilityFact,
} from "./model-capabilities.ts";

/** One measured performance facet for a (provider, modelId) route. */
export interface RoutePerformanceRecord {
	provider: string;
	modelId: string;
	/** Measured wall latency per call, in milliseconds. */
	avgLatencyMs: CapabilityFact<number>;
	/** Fraction of calls that failed (0..1). */
	errorRate: CapabilityFact<number>;
	/** Measured call count backing the latency sample. */
	sampleCount: CapabilityFact<number>;
}

export interface RoutePerformanceSnapshot {
	version: 1;
	savedAt: string;
	records: RoutePerformanceRecord[];
}

export const defaultRoutePerformanceSnapshotPath = (): string =>
	join(homedir(), ".claude", "local-llm", "route-performance.json");

const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

const unitRate = (value: unknown): number | null =>
	finite(value) !== null && (value as number) >= 0 && (value as number) <= 1
		? (value as number)
		: null;

/** Provenance source stamped on every fact aggregated from metrics.db. */
export const METRICS_SOURCE_PREFIX = "belt:metrics";

const FRESH_MS = 15 * 60_000;

export const routePerformanceFromTallies = (
	tallies: Readonly<Record<string, EndpointMetrics>>,
): RoutePerformanceRecord[] => {
	const records: RoutePerformanceRecord[] = [];
	for (const [endpointKey, tally] of Object.entries(tallies)) {
		const parts = endpointKey.split(":");
		const machine = parts[0] ?? "";
		const port = parts[1] ?? "";
		const modelId = parts.slice(2).join(":");
		const observedAt =
			tally.last_used !== null && validObservedAt(tally.last_used)
				? tally.last_used
				: null;
		if (!machine || !port || !modelId || !observedAt) continue;
		const source = `${METRICS_SOURCE_PREFIX}:${machine}:${port}`;
		const measured = positiveInteger(tally.measured);
		const avg = measured !== null ? finite(tally.avg_ms) : null;
		records.push({
			provider: machine,
			modelId,
			avgLatencyMs: fact(
				avg === null ? null : Math.round(avg),
				source,
				observedAt,
			),
			errorRate: fact(
				tally.calls > 0 ? tally.errors / tally.calls : null,
				source,
				observedAt,
			),
			sampleCount: fact(measured, source, observedAt),
		});
	}
	return records;
};

/** Preserve provenance when a fact expires, but never expose its old value. */
export const currentRoutePerformance = (
	record: RoutePerformanceRecord,
	maxAgeMs: number,
	now = Date.now(),
): RoutePerformanceRecord => ({
	...record,
	avgLatencyMs: fresh(record.avgLatencyMs, maxAgeMs, now),
	errorRate: fresh(record.errorRate, maxAgeMs, now),
	sampleCount: fresh(record.sampleCount, maxAgeMs, now),
});

const routeKey = (provider: string, modelId: string): string =>
	JSON.stringify([provider, modelId]);

export class RoutePerformanceRegistry {
	private readonly records = new Map<string, RoutePerformanceRecord>();

	constructor(records: RoutePerformanceRecord[] = []) {
		for (const record of records) this.upsert(record);
	}

	upsert(record: RoutePerformanceRecord): void {
		if (!record.provider || !record.modelId)
			throw new Error("provider and modelId are required");
		const composite = routeKey(record.provider, record.modelId);
		const previous = this.records.get(composite);
		const merged = previous
			? {
					...record,
					avgLatencyMs: newerFact(previous.avgLatencyMs, record.avgLatencyMs),
					errorRate: newerFact(previous.errorRate, record.errorRate),
					sampleCount: newerFact(previous.sampleCount, record.sampleCount),
				}
			: record;
		this.records.set(composite, structuredClone(merged));
	}

	get(
		provider: string,
		modelId: string,
		maxAgeMs: number,
		now = Date.now(),
	): RoutePerformanceRecord | null {
		const record = this.records.get(routeKey(provider, modelId));
		return record
			? currentRoutePerformance(structuredClone(record), maxAgeMs, now)
			: null;
	}

	all(): RoutePerformanceRecord[] {
		return [...this.records.values()].map((record) => structuredClone(record));
	}
}

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const nonNegative = (value: unknown): boolean => {
	const number = finite(value);
	return number !== null && number >= 0;
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

const validRecord = (value: unknown): value is RoutePerformanceRecord => {
	const row = object(value);
	return (
		!!row &&
		typeof row.provider === "string" &&
		!!row.provider &&
		typeof row.modelId === "string" &&
		!!row.modelId &&
		validFact(row.avgLatencyMs, nonNegative) &&
		validFact(row.errorRate, (value) => unitRate(value) !== null) &&
		validFact(row.sampleCount, (value) => positiveInteger(value) !== null)
	);
};

export const writeRoutePerformanceSnapshot = async (
	path: string,
	registry: RoutePerformanceRegistry,
	now = Date.now(),
): Promise<void> => {
	const snapshot: RoutePerformanceSnapshot = {
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

export const readRoutePerformanceSnapshot = async (
	path: string,
): Promise<
	| {
			state: "available";
			savedAt: string;
			registry: RoutePerformanceRegistry;
	  }
	| { state: "missing" | "invalid"; registry: RoutePerformanceRegistry }
> => {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { state: "missing", registry: new RoutePerformanceRegistry() };
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
			return { state: "invalid", registry: new RoutePerformanceRegistry() };
		return {
			state: "available",
			savedAt: snapshot.savedAt,
			registry: new RoutePerformanceRegistry(snapshot.records),
		};
	} catch {
		return { state: "invalid", registry: new RoutePerformanceRegistry() };
	}
};

export interface RoutePerformanceFeed {
	state: "available" | "partial";
	observedAt: string;
	maxAgeMs: number;
	records: RoutePerformanceRecord[];
	sources: {
		metrics: "tallied" | "unavailable";
		persistence: "saved" | "unavailable";
	};
}

const liveTallies = (): {
	tallies: Record<string, EndpointMetrics>;
	ok: boolean;
} => {
	try {
		return { tallies: metricsSnapshot().endpoints, ok: true };
	} catch {
		return { tallies: {}, ok: false };
	}
};

/** One collection pass: merge the fresh tally aggregation into the persisted
 *  store, re-write the snapshot, and return freshness-applied records. */
export const collectRoutePerformance = async (
	options: {
		tallies?: Readonly<Record<string, EndpointMetrics>>;
		path?: string;
		now?: number;
	} = {},
): Promise<RoutePerformanceFeed> => {
	const now = options.now ?? Date.now();
	const path = options.path ?? defaultRoutePerformanceSnapshotPath();
	const previous = await readRoutePerformanceSnapshot(path).catch(() => null);
	const registry = new RoutePerformanceRegistry(
		previous?.state === "available" ? previous.registry.all() : [],
	);
	const live = options.tallies
		? { tallies: options.tallies, ok: true }
		: liveTallies();
	for (const record of routePerformanceFromTallies(live.tallies))
		registry.upsert(record);
	let persistence: "saved" | "unavailable" = "unavailable";
	try {
		await writeRoutePerformanceSnapshot(path, registry, now);
		persistence = "saved";
	} catch {
		persistence = "unavailable";
	}
	const records = registry
		.all()
		.map((record) => currentRoutePerformance(record, FRESH_MS, now));
	return {
		state: persistence === "saved" ? "available" : "partial",
		observedAt: new Date(now).toISOString(),
		maxAgeMs: FRESH_MS,
		records,
		sources: { metrics: live.ok ? "tallied" : "unavailable", persistence },
	};
};
