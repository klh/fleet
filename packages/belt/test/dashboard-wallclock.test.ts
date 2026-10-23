// test/dashboard-wallclock.test.ts — W902: the belt dashboard stamp module is
// the JS mirror of suspenders hooks/lib/wallclock.ts — same forms, one
// vocabulary across every fleet surface.
import { describe, expect, test } from "bun:test";
import { dualShort, dualStamp } from "../bin/dashboard-wallclock.js";
import {
	dualShort as libShort,
	dualStamp as libStamp,
} from "../../suspenders/hooks/lib/wallclock.ts";

// 2026-10-19T15:44:54Z — the W902 mint instant (local twin depends on the
// machine's offset, so only the UTC half is asserted verbatim)
const T = Date.UTC(2026, 9, 19, 15, 44, 54);

describe("belt dashboard wallclock (W902)", () => {
	test("dualStamp renders UTC-first with a parenthesized local twin", () => {
		const s = dualStamp(T);
		expect(s).toContain("2026-10-19T15:44:54Z");
		expect(s).toMatch(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\)/);
	});

	test("dualShort keeps both halves dense", () => {
		const s = dualShort(T);
		expect(s).toContain("10-19T15:44:54Z");
		expect(s).toMatch(/\(\d{2}:\d{2} local\)/);
	});

	test("byte-parity with the suspenders lib forms (one vocabulary)", () => {
		for (const t of [
			T,
			T + 61_000,
			T - 3_600_000,
			Date.UTC(2026, 0, 2, 5, 6, 7),
		]) {
			expect(dualStamp(t)).toBe(libStamp(t));
			expect(dualShort(t)).toBe(libShort(t));
		}
	});
});
