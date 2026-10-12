// test/lane-sid.test.ts — W460: the lane sid derivation is injective for all
// W-labels. Dots map to '-' so W1.23 and W12.3 can no longer share a lane
// registry slot; dotless labels keep the legacy output byte-for-byte (live
// lane names don't break).
import { describe, test, expect } from "bun:test";
import { laneSid, supSid } from "../hooks/lib/laneslug.ts";
import { sidOf } from "../scripts/dispatch-next.ts";

describe("lane sid derivation (W460)", () => {
	test("fresh lanes are unique across projects with equal work labels", () => {
		const first = laneSid("W1", "/repos/one/.git");
		const second = laneSid("W1", "/repos/two/.git");
		expect(first).not.toBe(second);
		expect(first).toBe(laneSid("W1", "/repos/one/.git"));
		expect(first).toMatch(/^autow1-p[0-9a-f]{16}$/);
		expect(first.startsWith(laneSid("W10", "/repos/one/.git"))).toBe(false);
	});
	test("dotless labels keep the legacy slug", () => {
		expect(laneSid("W44")).toBe("autow44");
		expect(laneSid("W1230")).toBe("autow1230");
	});

	test("dotted labels stay injective: W1.23 vs W12.3", () => {
		expect(laneSid("W1.23")).toBe("autow1-23");
		expect(laneSid("W12.3")).toBe("autow12-3");
		expect(laneSid("W1.23")).not.toBe(laneSid("W12.3"));
	});

	test("nested children map uniquely", () => {
		expect(laneSid("W4.1")).toBe("autow4-1");
		expect(laneSid("W4.1")).not.toBe(laneSid("W41"));
		expect(laneSid("W4.1.2")).toBe("autow4-1-2");
	});

	test("dispatch-next's sidOf is the same derivation", () => {
		expect(sidOf("W44")).toBe("autow44");
		expect(sidOf("W1.23")).toBe(laneSid("W1.23"));
	});
});

// W614: the micro-supervisor sid shares the injective label grammar — before
// this it stripped dots inline, so W1.23 and W12.3 both became sup123.
describe("supervisor sid derivation (W614)", () => {
	test("dotted parents stay injective", () => {
		expect(supSid("W1.23")).toBe("sup1-23");
		expect(supSid("W12.3")).toBe("sup12-3");
		expect(supSid("W1.23")).not.toBe(supSid("W12.3"));
		expect(supSid("W44")).toBe("sup44");
	});
	test("never collides with lane sids of the same label", () => {
		expect(supSid("W1.23")).not.toBe(laneSid("W1.23"));
	});
});
