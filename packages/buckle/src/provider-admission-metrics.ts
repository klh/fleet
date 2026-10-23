/** Configured account-pool IDs are the only label: never requests or keys. */
export type ProviderAdmissionSnapshots = Record<string, Record<string, number>>;

const FIELDS = {
	active: "active",
	queued: "queued",
	outstanding: "outstanding",
	baseGapMs: "base_gap_ms",
	adaptiveGapMs: "adaptive_gap_ms",
	adaptiveConcurrency: "adaptive_concurrency",
	concurrencyCeiling: "concurrency_ceiling",
	concurrencyLimitedTotal: "concurrency_limited_total",
	concurrencyRecoverySuccesses: "concurrency_recovery_successes",
	notBeforeMs: "not_before_ms",
	rateLimitedTotal: "rate_limited_total",
	recoverySuccesses: "recovery_successes",
	feedbackEpoch: "feedback_epoch",
} as const;

/** Scrape current state through the existing private joined metrics endpoint. */
export function providerAdmissionMetrics(
	pools: ProviderAdmissionSnapshots,
): string {
	const lines: string[] = [];
	for (const [field, suffix] of Object.entries(FIELDS)) {
		const name = `buckle_provider_pool_${suffix}`;
		lines.push(
			`# TYPE ${name} ${suffix.endsWith("_total") ? "counter" : "gauge"}`,
		);
		for (const [pool, snapshot] of Object.entries(pools)) {
			const value = snapshot[field];
			if (!Number.isFinite(value) || value < 0) continue;
			const label = pool
				.replace(/\\/g, "\\\\")
				.replace(/\n/g, "\\n")
				.replace(/"/g, '\\"');
			lines.push(`${name}{pool="${label}"} ${value}`);
		}
	}
	return `${lines.join("\n")}\n`;
}
