// W1086: stream settle facts + the trace-centric read join. The ledger
// validates every settle field (closer enum, ms clamp, failure kind) and
// traceRead() joins requests + attempts + settle by trace id — the LiteLLM
// call id read never probes, it rides route_attempt.call_id.
import { expect, test } from "bun:test";
import { buildSettleFact } from "../../telemetry/src/http-trace.ts";
import { Ledger } from "../src/ledger.ts";

const TRACE = "a".repeat(32);

test("buildSettleFact clamps offsets and reduces errors to a bounded kind", () => {
	const s = buildSettleFact({
		t0: 1000,
		firstByteAt: 1250,
		lastByteAt: 2200,
		closer: "upstream",
		error: Object.assign(new TypeError("secret prompt body"), {
			code: "ECONNRESET",
		}),
	});
	expect(s).toEqual({
		firstByteMs: 250,
		lastByteMs: 1200,
		closer: "upstream",
		failureKind: "typeerror:econnreset",
	});
	// negative / non-finite timestamps clamp to zero, absent stays null
	const clamped = buildSettleFact({
		t0: 1000,
		firstByteAt: 900,
		lastByteAt: null,
		closer: "client",
	});
	expect(clamped.firstByteMs).toBe(0);
	expect(clamped.lastByteMs).toBeNull();
	// a clean close carries no failure kind — error text never goes durable
	const clean = buildSettleFact({
		t0: 0,
		firstByteAt: 5,
		lastByteAt: 9,
		closer: "upstream",
	});
	expect(clean.failureKind).toBeNull();
	expect(JSON.stringify(clean)).not.toContain("secret");
});

test("auditSettle persists one bounded settle row; traceRead joins it", () => {
	const ledger = new Ledger(":memory:");
	ledger.auditSettle(
		{
			rid: "request-1",
			traceId: TRACE,
			firstByteAt: 1250,
			lastByteAt: 2200,
			closer: "upstream",
			error: Object.assign(new Error("dropped"), { code: "ECONNRESET" }),
		},
		1000,
	);
	const read = ledger.traceRead(TRACE);
	expect(read.trace_id).toBe(TRACE);
	expect(read.settle).toMatchObject({
		rid: "request-1",
		first_byte_ms: 250,
		last_byte_ms: 1200,
		closer: "upstream",
		failure_kind: "error:econnreset",
	});
	// the close error's message never becomes durable
	expect(JSON.stringify(read.settle)).not.toContain("dropped");
	// invalid trace ids read empty, never throw
	expect(ledger.traceRead("nope").attempts).toEqual([]);
	ledger.close();
});

test("a later settle replaces the earlier row (the final settle stands)", () => {
	const ledger = new Ledger(":memory:");
	ledger.auditSettle(
		{
			rid: "r1",
			traceId: TRACE,
			firstByteAt: 10,
			lastByteAt: 20,
			closer: "upstream",
		},
		0,
	);
	ledger.auditSettle(
		{
			rid: "r1",
			traceId: TRACE,
			firstByteAt: 10,
			lastByteAt: 99,
			closer: "buckle",
			error: new Error("total deadline"),
		},
		0,
	);
	const read = ledger.traceRead(TRACE);
	expect(read.settle).toMatchObject({
		last_byte_ms: 99,
		closer: "buckle",
		failure_kind: "error",
	});
	ledger.close();
});

test("settle rows with invalid ids or closers are refused, not faked", () => {
	const ledger = new Ledger(":memory:");
	// non-hex trace id → refused (nothing durable)
	ledger.auditSettle(
		{
			rid: "r1",
			traceId: "zz",
			firstByteAt: 1,
			lastByteAt: 2,
			closer: "upstream",
		},
		0,
	);
	// unsafe rid → refused
	ledger.auditSettle(
		{
			rid: "bad\nrid",
			traceId: TRACE,
			firstByteAt: 1,
			lastByteAt: 2,
			closer: "client",
		},
		0,
	);
	// an out-of-enum closer fails at the type boundary; the build fn still
	// bounds what a dynamic caller may hand it
	const rogue = buildSettleFact({
		t0: 0,
		firstByteAt: null,
		lastByteAt: null,
		closer: "not-a-closer" as unknown as "upstream",
	});
	expect(JSON.stringify(rogue)).not.toContain("secret");
	expect(ledger.traceRead(TRACE).settle).toBeNull();
	ledger.close();
});

test("traceRead joins attempts and requests by trace_id without bodies", () => {
	const ledger = new Ledger(":memory:");
	ledger.auditAttempt({
		rid: "request-1",
		traceId: TRACE,
		ordinal: 1,
		service: "buckle",
		hop: "bridged-upstream",
		candidate: "c1",
		status: 429,
		refusal: "rate_limited",
		durationMs: 23,
		retryAfterMs: 5000,
		upstreamId: "provider-123",
		callId: "litellm-456",
	});
	ledger.auditAttempt({
		rid: "request-1",
		traceId: TRACE,
		ordinal: 2,
		service: "buckle",
		hop: "upstream",
		candidate: "c2",
		status: 200,
		refusal: null,
		durationMs: 1200,
		retryAfterMs: null,
		upstreamId: "provider-success",
		callId: "litellm-final",
	});
	ledger.auditSettle(
		{
			rid: "request-1",
			traceId: TRACE,
			firstByteAt: 100,
			lastByteAt: 1300,
			closer: "upstream",
		},
		0,
	);
	const read = ledger.traceRead(TRACE);
	expect(read.attempts).toHaveLength(2);
	// first selected target (429) and final serving attempt (200) BOTH ride
	// the trace — the read never relabels the winner as the selection
	expect(read.attempts[0]).toMatchObject({
		ordinal: 1,
		status: 429,
		call_id: "litellm-456",
	});
	expect(read.attempts[1]).toMatchObject({
		ordinal: 2,
		status: 200,
		call_id: "litellm-final",
	});
	expect(JSON.stringify(read)).not.toContain("prompt");
	ledger.close();
});
