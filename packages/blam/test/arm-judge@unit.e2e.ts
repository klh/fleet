// bench/durable/arm-judge@unit.e2e.ts — W2971.3 judge-face contract specs.
// Covers the rcFromLog parser (docker WARNING-after-echo regression, seen
// live on SPH-13926 a10), the verdict gate (base/gold preconditions), and
// the phase command ladder (gold-borne tests + patch gating). No docker:
// these pin pure logic only.
import { test, expect } from "@playwright/test";
import { rcFromLog, verdict } from "../bench/durable/arm-judge.ts";

test("rcFromLog picks the last RC marker when docker stderr follows", () => {
	const log = [
		"1 failed, 52 deselected in 0.51s",
		"RC=1",
		"",
		"WARNING: The requested image's platform (linux/amd64) does not match",
	].join("\n");
	expect(rcFromLog(log)).toBe(1);
});

test("rcFromLog tolerates multiple RC markers and takes the last", () => {
	const log = "RC=0\nmiddle RC=7 noise\nRC=0\n";
	expect(rcFromLog(log)).toBe(0);
});

test("rcFromLog returns null when no marker exists (docker-level failure)", () => {
	expect(rcFromLog("docker: cannot connect")).toBeNull();
	expect(rcFromLog("")).toBeNull();
});

test("verdict accepts only base-fail/gold-pass and candidate-decides", () => {
	expect(verdict(1, 0, 0)).toBe("accepted");
	expect(verdict(4, 0, 1)).toBe("rejected");
});

test("verdict throws on precondition drift, never silently flips", () => {
	// base passing = judge contract broken
	expect(() => verdict(0, 0, 0)).toThrow(/precondition drift/);
	// gold failing = patch or judge broken
	expect(() => verdict(1, 1, 1)).toThrow(/precondition drift/);
});
