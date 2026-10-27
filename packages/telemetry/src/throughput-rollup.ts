import type {
	ThroughputBaseline,
	ThroughputBucket,
	ThroughputEvaluation,
} from "./throughput.ts";

type View = ThroughputEvaluation & { bucket: ThroughputBucket };
const sums = [
	"requests",
	"successes",
	"failures",
	"attempts",
	"retries",
	"knownUsage",
	"unknownUsage",
	"outTokens",
	"knownServiceMs",
	"serviceTokens",
	"serviceSamples",
	"matchedTotalMs",
	"queueMs",
	"queueSamples",
	"totalMs",
	"demandSamples",
] as const;

/** Aggregate observed work, not sums of per-cohort speeds. Composite
 * baselines reuse each persisted cohort's expected service time under the
 * CURRENT model/context mix, so a mix change is not a throughput incident. */
export function rollupThroughput(rows: readonly View[]) {
	const rollups = new Map<
		string,
		{
			dimension: string;
			id: string | null;
			bucket: ThroughputBucket;
			expectedMs: number;
			expectedTotalMs: number;
			comparable: boolean;
			cohorts: number;
			incident: boolean;
		}
	>();
	for (const row of rows) {
		const b = row.bucket;
		for (const [dimension, id] of [
			["total", null],
			["requested_group", b.group],
			["model", b.model],
			["provider", b.provider],
		] as const) {
			const key = JSON.stringify([b.node, b.bucket, dimension, id]);
			let group = rollups.get(key);
			if (!group) {
				const empty = { ...b };
				for (const field of sums) empty[field] = 0;
				group = {
					dimension,
					id,
					bucket: empty,
					expectedMs: 0,
					expectedTotalMs: 0,
					comparable: true,
					cohorts: 0,
					incident: false,
				};
				rollups.set(key, group);
			}
			for (const field of sums) group.bucket[field] += b[field];
			group.bucket.lastAt = Math.max(group.bucket.lastAt, b.lastAt);
			group.bucket.paused ||= b.paused;
			group.bucket.saturated ||= b.saturated;
			group.cohorts++;
			group.incident ||= !!row.baseline?.incident;
			const reference: ThroughputBaseline | null = row.baseline;
			if (
				(row.state === "healthy" || row.state === "degraded") &&
				reference &&
				reference.rate > 0 &&
				reference.endToEndRate > 0
			) {
				group.expectedMs += (b.serviceTokens * 1000) / reference.rate;
				group.expectedTotalMs +=
					(b.serviceTokens * 1000) / reference.endToEndRate;
			} else group.comparable = false;
		}
	}
	return [...rollups.values()].map((group) => ({
		...group,
		baselineRate:
			group.comparable && group.expectedMs > 0
				? (group.bucket.serviceTokens * 1000) / group.expectedMs
				: null,
		baselineEndToEndRate:
			group.comparable && group.expectedTotalMs > 0
				? (group.bucket.serviceTokens * 1000) / group.expectedTotalMs
				: null,
	}));
}
