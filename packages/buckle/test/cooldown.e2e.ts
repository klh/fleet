// test/cooldown.test.ts — ported retry-after math (both header forms).
import { expect, test } from "@playwright/test";
import { retryAfterS, retryDelayS } from "../src/cooldown.ts";

test.describe({ tag: "@unit" }, () => {
	test.describe("retryDelayS", () => {
		test("zero provider wait cannot collapse retries into an immediate burst", () => {
			expect(retryDelayS(0, 0, () => 0, 8, 60)).toBe(1);
			expect(retryDelayS(3, 0.05, () => 0.5, 8, 60)).toBe(8.5);
			expect(retryDelayS(5, 20, () => 0.5, 8, 60)).toBe(20.5);
			expect(retryDelayS(0, null, () => -1, 0, 60)).toBe(1);
		});
		test("upstream retry-after honored (+ jitter)", () => {
			expect(retryDelayS(0, 3.5, () => 0, 8, 60)).toBe(3.5);
			expect(retryDelayS(0, 3.5, () => 0.5, 8, 60)).toBe(4);
		});

		test("absent header → capped exponential + jitter", () => {
			expect(retryDelayS(0, null, () => 0, 8, 60)).toBe(1);
			expect(retryDelayS(1, null, () => 0, 8, 60)).toBe(2);
			expect(retryDelayS(5, null, () => 0, 8, 60)).toBe(8);
		});

		test("absent header: exponential + U[0,1) jitter added", () => {
			// attempt 3: cap 8, plus jitter 0.5
			expect(retryDelayS(3, null, () => 0.5, 8, 60)).toBe(8.5);
		});

		test("provider floor capped at retry_after_cap_s (W695.6.1 quota wall)", () => {
			expect(retryDelayS(0, 1670111, () => 0, 8, 60)).toBe(60);
			expect(retryDelayS(5, 90, () => 0, 8, 60)).toBe(60);
			expect(retryDelayS(0, 3.5, () => 0, 8, 60)).toBe(3.5); // below cap: verbatim
			expect(retryDelayS(0, 1670111, () => 0.5, 8, 60)).toBe(60.5); // jitter rides the cap
			expect(retryDelayS(0, 1670111, () => 0, 8, 0)).toBe(1); // floor cap 0 → min 1s
			expect(retryDelayS(0, 1670111, () => 0, 8, Number.NaN)).toBe(60); // non-finite → default
		});
	});

	test.describe("retryAfterS", () => {
		test("delta-seconds form", () => {
			const h = new Headers({ "retry-after": "7" });
			expect(retryAfterS(h, () => 1000)).toBe(7);
		});

		test("HTTP-date form", () => {
			const h = new Headers({ "retry-after": new Date(5000).toUTCString() });
			expect(retryAfterS(h, () => 1000)).toBe(4);
		});

		test("absent header → null", () => {
			expect(retryAfterS(new Headers(), () => 1000)).toBeNull();
		});
	});
});
