import { expect, test } from "bun:test";
import { Ledger } from "../src/ledger.ts";

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
		layer: "network",
		durationMs: 23,
		retryAfterMs: 5000,
		upstreamId: "provider-123",
		callId: "litellm-456",
	});
	const attempts = ledger.traceAttempts(traceId);
	expect(attempts).toHaveLength(1);
	expect(attempts[0]).toMatchObject({
		rid: "request-1",
		ordinal: 1,
		status: 429,
		refusal: "upstream-rate-limit",
		layer: "network",
		retry_after_ms: 5000,
		upstream_id: "provider-123",
		call_id: "litellm-456",
	});
	expect(ledger.traceAttempts("b".repeat(32))).toEqual([]);
	ledger.close();
});
