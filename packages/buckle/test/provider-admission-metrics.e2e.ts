import { expect, test } from "@playwright/test";
import { providerAdmissionMetrics } from "../src/provider-admission-metrics.ts";

test.describe({ tag: "@unit" }, () => {
	test("pool metrics use only fixed numeric fields and escaped configured IDs", () => {
		const text = providerAdmissionMetrics({
			'account"\n\\': {
				active: 1,
				queued: -1,
				outstanding: Number.NaN,
				baseGapMs: 500,
				rateLimitedTotal: 4,
				adaptiveConcurrency: 3,
				concurrencyCeiling: 50,
				concurrencyLimitedTotal: 2,
				requestId: 123,
			},
		});
		expect(text).toContain(
			'buckle_provider_pool_active{pool="account\\"\\n\\\\"} 1',
		);
		expect(text).toContain(
			"# TYPE buckle_provider_pool_rate_limited_total counter",
		);
		expect(text).not.toContain("requestId");
		expect(text).toContain(
			"# TYPE buckle_provider_pool_concurrency_limited_total counter",
		);
		expect(text).toContain(
			'buckle_provider_pool_adaptive_concurrency{pool="account\\"\\n\\\\"} 3',
		);
		expect(text).not.toContain(" -1");
		expect(text).not.toContain("NaN");
	});
});
