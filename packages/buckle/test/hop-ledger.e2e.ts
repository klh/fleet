import { expect, test } from "@playwright/test";
import { Ledger } from "../src/ledger.ts";

test.describe({ tag: "@unit" }, () => {
	test("Buckle joins bounded hop receipts by trace without serving bodies", () => {
		const ledger = new Ledger(":memory:");
		const traceId = "a".repeat(32);
		ledger.auditAttempt({
			rid: "request-1",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate: "zai-primary",
			status: 429,
			refusal: "upstream-rate-limit",
			durationMs: 23,
			retryAfterMs: 5000,
			upstreamId: "provider-123",
			callId: "litellm-456",
			providerPool: "account",
			queueWaitMs: 123,
			providerErrorCode: "1302",
			providerErrorType: "rate_limit_error",
		});
		const attempts = ledger.traceAttempts(traceId);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			rid: "request-1",
			ordinal: 1,
			status: 429,
			refusal: "upstream-rate-limit",
			retry_after_ms: 5000,
			upstream_id: "provider-123",
			call_id: "litellm-456",
			provider_pool: "account",
			queue_wait_ms: 123,
			provider_error_code: "1302",
			provider_error_type: "rate_limit_error",
		});
		expect(ledger.traceAttempts("b".repeat(32))).toEqual([]);
		ledger.close();
	});

	test("unknown or invalid account queue measurements remain null", () => {
		const ledger = new Ledger(":memory:");
		const traceId = "c".repeat(32);
		for (const [ordinal, queueWaitMs] of [
			undefined,
			-1,
			Number.POSITIVE_INFINITY,
			0.5,
			0,
		].entries()) {
			ledger.auditAttempt({
				rid: "queue-bounds",
				traceId,
				ordinal: ordinal + 1,
				service: "buckle",
				hop: "upstream",
				candidate: "fixture",
				status: 200,
				refusal: null,
				durationMs: 1,
				retryAfterMs: null,
				upstreamId: null,
				callId: null,
				providerPool: "unsafe\npool",
				queueWaitMs,
				providerErrorCode: ["sk-", "syntheticcredential"].join(""),
				providerErrorType: "unsafe\nvalue",
			});
		}
		const rows = ledger.traceAttempts(traceId);
		expect(rows.map((r) => r.queue_wait_ms)).toEqual([
			null,
			null,
			null,
			null,
			0,
		]);
		expect(rows.every((r) => r.provider_pool === null)).toBe(true);
		expect(
			rows.every(
				(r) => r.provider_error_code === null && r.provider_error_type === null,
			),
		).toBe(true);
		ledger.close();
	});
});
