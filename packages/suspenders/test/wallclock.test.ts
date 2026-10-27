// test/wallclock.test.ts — W902: the dual-stamp vocabulary. UTC Z first,
// local twin beside it; storage stays epoch-ms.
import { describe, expect, test } from "bun:test";
import {
	dualShort,
	dualStamp,
	embedDualShort,
	embedDualStamp,
	localIso,
	utcZ,
} from "../hooks/lib/wallclock.ts";

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
		expect(T - new Date(`${local.slice(0, 19)}Z`).getTime()).toBe(
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

	test("embed faces stay byte-parity with the lib forms (one vocabulary)", () => {
		for (const t of [T, T + 61_000, T - 3_600_000, Date.UTC(2026, 0, 2, 5, 6, 7)]) {
			expect(embedDualStamp(t)).toBe(dualStamp(t));
			expect(embedDualShort(t)).toBe(dualShort(t));
			// the string/Date input paths land the same instant
			expect(embedDualStamp(new Date(t))).toBe(embedDualStamp(t));
		}
	});

	test("embed faces render the chunk contract for falsy/NaN input", () => {
		expect(embedDualStamp(0)).toBe("");
		expect(embedDualStamp("")).toBe("");
		expect(embedDualShort(0)).toBe("");
		expect(embedDualStamp("not-a-time")).toBe("not-a-time");
	});

	test("embeds are self-contained (no module-scope refs) — chunk-inlinable", () => {
		for (const [fn, lib] of [
			[embedDualStamp, dualStamp],
			[embedDualShort, dualShort],
		]) {
			const src = fn.toString();
			expect(src).not.toMatch(/\b(utcZ|localIso|embedDual\w+)\(/);
			// evaluates standalone and still lands the lib form
			const out = new Function("t", `return (${src})(t)`)(T);
			expect(out).toBe(lib(T));
		}
		expect(embedDualShort.toString()).toMatch(/^function dualShort\b/);
	});
});
