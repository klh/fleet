import type { ThroughputStore } from "@klh/telemetry/src/throughput-store.ts";
import type { ThroughputBucket } from "@klh/telemetry/src/throughput.ts";
import { rollupThroughput } from "@klh/telemetry/src/throughput-rollup.ts";

function bucketValues(
	b: ThroughputBucket,
	bucketMs: number,
	now: number,
): Record<string, number | null> {
	const windowMs = Math.max(1, Math.min(bucketMs, now - b.bucket));
	return {
		requests_per_second: (b.requests * 1000) / windowMs,
		attempts_per_second: (b.attempts * 1000) / windowMs,
		successes: b.successes,
		failures: b.failures,
		retries: b.retries,
		reported_usage_samples: b.knownUsage,
		unknown_usage_samples: b.unknownUsage,
		reported_output_tokens: b.knownUsage ? b.outTokens : null,
		reported_output_tokens_per_second: b.knownUsage
			? (b.outTokens * 1000) / windowMs
			: null,
		service_output_tokens_per_second: b.knownServiceMs
			? (b.serviceTokens * 1000) / b.knownServiceMs
			: null,
		end_to_end_output_tokens_per_second: b.matchedTotalMs
			? (b.serviceTokens * 1000) / b.matchedTotalMs
			: null,
		queue_wait_mean_ms: b.queueSamples ? b.queueMs / b.queueSamples : null,
		end_to_end_mean_ms: b.requests ? b.totalMs / b.requests : null,
		sample_age_seconds: Math.max(0, now - b.lastAt) / 1000,
		window_closed: b.bucket + bucketMs <= now ? 1 : 0,
	};
}

function appendMetrics(
	lines: string[],
	labels: Record<string, string>,
	values: Record<string, number | null>,
) {
	const encoded = Object.entries(labels)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(",");
	for (const [name, value] of Object.entries(values))
		if (value !== null)
			lines.push(`buckle_throughput_${name}{${encoded}} ${value}`);
}

/** Cohorts are node-local and comparable; never sum hop rates to claim
 * fleet throughput. Unknown usage omits the rate, not a fabricated zero. */
export function throughputMetrics(store: ThroughputStore, now: number): string {
	const latest = new Map<
		string,
		ReturnType<ThroughputStore["snapshot"]>[number]
	>();
	const snapshot = store.snapshot(now);
	for (const row of snapshot)
		latest.set(`${row.bucket.node}\0${row.bucket.key}`, row);
	const lines: string[] = [];
	for (const row of latest.values()) {
		const b = row.bucket;
		const labels = {
			scope: row.scope,
			dimension: "cohort",
			node: b.node,
			requested_group: b.group ?? "unknown",
			model: b.model ?? "unknown",
			provider: b.provider ?? "unknown",
			provider_profile: b.providerProfile ?? "unknown",
			effort: b.effort ?? "unknown",
			context: b.context ?? "unknown",
		};
		appendMetrics(lines, labels, {
			...bucketValues(b, store.policy.bucketMs, now),
			baseline_rate: row.baseline?.rate ?? null,
			baseline_end_to_end_rate: row.baseline?.endToEndRate ?? null,
			baseline_samples: row.baseline?.samples ?? 0,
			relative_rate: row.ratio,
			incident_active: row.baseline?.incident ? 1 : 0,
			comparable: row.state === "healthy" || row.state === "degraded" ? 1 : 0,
		});
	}
	const latestBucket = new Map<string, number>();
	for (const row of snapshot)
		latestBucket.set(
			row.bucket.node,
			Math.max(latestBucket.get(row.bucket.node) ?? 0, row.bucket.bucket),
		);
	for (const group of rollupThroughput(
		snapshot.filter(
			(row) => row.bucket.bucket === latestBucket.get(row.bucket.node),
		),
	)) {
		const b = group.bucket;
		appendMetrics(
			lines,
			{
				scope: "node_local",
				dimension: group.dimension,
				node: b.node,
				requested_group:
					group.dimension === "requested_group"
						? (group.id ?? "unknown")
						: "all",
				model: group.dimension === "model" ? (group.id ?? "unknown") : "all",
				provider:
					group.dimension === "provider" ? (group.id ?? "unknown") : "all",
			},
			{
				...bucketValues(b, store.policy.bucketMs, now),
				baseline_rate: group.baselineRate,
				baseline_end_to_end_rate: group.baselineEndToEndRate,
				cohorts: group.cohorts,
				comparable: group.comparable ? 1 : 0,
			},
		);
	}
	for (const incident of store.incidents()) {
		const identity = JSON.parse(incident.body) as {
			bucket: {
				group: string | null;
				model: string | null;
				provider: string | null;
			};
		};
		const labels = Object.entries({
			scope: "node_local",
			node: incident.node,
			incident: incident.id,
			requested_group: identity.bucket.group ?? "unknown",
			model: identity.bucket.model ?? "unknown",
			provider: identity.bucket.provider ?? "unknown",
		})
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(",");
		lines.push(
			`buckle_throughput_incident{${labels}} ${incident.ended === null ? 1 : 0}`,
		);
		lines.push(
			`buckle_throughput_incident_started_ms{${labels}} ${incident.started}`,
		);
		if (incident.ended !== null)
			lines.push(
				`buckle_throughput_incident_recovered_ms{${labels}} ${incident.ended}`,
			);
	}
	for (const capacity of store.capacitySignals(now))
		appendMetrics(
			lines,
			{
				scope: "node_local",
				node: capacity.node,
				bucket_ms: String(capacity.bucket),
			},
			{ collection_capacity_refusals: capacity.dropped },
		);
	return `${lines.join("\n")}\n`;
}
