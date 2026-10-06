// test/lane-sid.test.ts — W460: the lane sid derivation is injective for all
// W-labels. Dots map to '-' so W1.23 and W12.3 can no longer share a lane
// registry slot; dotless labels keep the legacy output byte-for-byte (live
// lane names don't break).
import { describe, test, expect } from "bun:test";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { sidOf } from "../scripts/dispatch-next.ts";

describe("lane sid derivation (W460)", () => {
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
