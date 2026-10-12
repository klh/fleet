// test/trace.test.ts — W461 stage 1: W3C traceparent parse/build and the
// fleet baggage allowlist. Correlation only — no identity, no authz.
import { describe, expect, test } from "bun:test";
import {
	allowlistedBaggage,
	childSpanOf,
	newTraceparent,
	parseTraceparent,
	stripPrivateTrace,
} from "../src/trace.ts";

const GOOD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
	test("accepts a valid header, canonicalized to lowercase", () => {
		expect(parseTraceparent(GOOD)).toBe(GOOD);
		expect(
			parseTraceparent(
				" 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01 ",
			),
		).toBe(GOOD);
	});

	test("rejects garbage, zero ids, forbidden version, bad flags", () => {
		expect(parseTraceparent(null)).toBe(null);
		expect(parseTraceparent(undefined)).toBe(null);
		expect(parseTraceparent("")).toBe(null);
		expect(parseTraceparent("not-a-traceparent")).toBe(null);
		expect(
			parseTraceparent(
				"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
			),
		).toBe(null);
		expect(
			parseTraceparent(
				"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
			),
		).toBe(null);
		expect(
			parseTraceparent(
				"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			),
		).toBe(null);
		expect(
			parseTraceparent(
				"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz",
			),
		).toBe(null);
	});
});

describe("childSpanOf", () => {
	test("same trace id, fresh distinct span ids per attempt", () => {
		const a = childSpanOf(GOOD);
		const b = childSpanOf(GOOD);
		expect(a.split("-")[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(b.split("-")[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(a.split("-")[2]).not.toBe(b.split("-")[2]);
		expect(a).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
	});

	test("absent or invalid parent roots a fresh valid trace", () => {
		for (const p of [null, undefined, "", "garbage"]) {
			const t = childSpanOf(p);
			expect(parseTraceparent(t)).toBe(t);
			expect(t.split("-")[1]).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		}
	});

	test("newTraceparent yields a valid root", () => {
		expect(parseTraceparent(newTraceparent())).not.toBe(null);
	});
});

describe("allowlistedBaggage", () => {
	test("keeps fleet.* keys, drops everything else", () => {
		const v = "fleet.lane.id=autow461,secret=x,fleet.project.id=p1,sid=abc";
		expect(allowlistedBaggage(v)).toBe(
			"fleet.lane.id=autow461,fleet.project.id=p1",
		);
	});

	test("baggage properties after ';' are dropped, value rides verbatim", () => {
		expect(allowlistedBaggage("fleet.hub.id=nas;prop=1")).toBe(
			"fleet.hub.id=nas",
		);
	});

	test("empty, absent or all-private baggage → null", () => {
		expect(allowlistedBaggage(null)).toBe(null);
		expect(allowlistedBaggage("")).toBe(null);
		expect(allowlistedBaggage("sid=abc,secret=x")).toBe(null);
	});
});

describe("stripPrivateTrace", () => {
	test("baggage never rides the upstream leg; traceparent survives", () => {
		const h: Record<string, string> = {
			authorization: "Bearer x",
			baggage: "fleet.lane.id=autow461",
			traceparent: GOOD,
		};
		stripPrivateTrace(h);
		expect(h.baggage).toBeUndefined();
		expect(h.traceparent).toBe(GOOD);
	});
});
