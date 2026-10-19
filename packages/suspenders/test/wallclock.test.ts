// test/wallclock.test.ts — W902: the dual-stamp vocabulary. UTC Z first,
// local twin beside it; storage stays epoch-ms.
import { describe, expect, test } from "bun:test";
import { dualShort, dualStamp, localIso, utcZ } from "../hooks/lib/wallclock.ts";

// 2026-10-19T15:44:54Z — the W902 mint instant (local twin depends on the
// machine's offset, so only the UTC half is asserted verbatim)
const T = Date.UTC(2026, 9, 19, 15, 44, 54);

describe("wallclock dual stamps (W902)", () => {
	test("utcZ renders ISO with a Z suffix, no millis", () => {
		expect(utcZ(T)).toBe("2026-10-19T15:44:54Z");
		expect(utcZ(T)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	});

	test("localIso carries an explicit numeric offset", () => {
		expect(localIso(T)).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
		);
		// the offset must round-trip to the same instant
		const local = localIso(T);
		const m = /([+-])(\d{2}):(\d{2})$/.exec(local);
		const off =
			(m?.[1] === "-" ? -1 : 1) *
			(Number(m?.[2]) * 60 + Number(m?.[3]));
		expect(T - new Date(local.slice(0, 19) + "Z").getTime()).toBe(
			off * 60_000,
		);
	});

	test("dualStamp = UTC Z + parenthesized local twin", () => {
		const s = dualStamp(T);
		expect(s).toContain("2026-10-19T15:44:54Z");
		expect(s).toMatch(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\)/);
	});

	test("dualShort keeps both halves dense", () => {
		const s = dualShort(T);
		expect(s).toContain("10-19T15:44:54Z");
		expect(s).toMatch(/\(\d{2}:\d{2} local\)/);
	});

	test("Date inputs ride the same path as epoch millis", () => {
		expect(utcZ(new Date(T))).toBe(utcZ(T));
		expect(dualStamp(new Date(T))).toBe(dualStamp(T));
	});
});
