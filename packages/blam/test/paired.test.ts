// packages/blam/test/paired.test.ts — paired-arm runner tests (W612):
// lift math, per-case behavior, determinism, bench properties.
import { describe, expect, test } from "bun:test";
import {
	checkProperties,
	formatReport,
	REPS,
	runAll,
	runCase,
} from "../bench/paired/harness.ts";
import { CASE_NAMES, resumePolicyVerdict } from "../bench/paired/cases.ts";
import { pairedLift, type PairedRep } from "../bench/paired/types.ts";

function pair(
	rep: number,
	on: Partial<PairedRep["on"]>,
	off: Partial<PairedRep["off"]>,
): PairedRep {
	return {
		rep,
		setup: "t",
		on: { correct: 1, tokens: 0, minutes: 0, ...on },
		off: { correct: 1, tokens: 0, minutes: 0, ...off },
	};
}

describe("paired lift math", () => {
	test("empty pairs → zero lift", () => {
		const l = pairedLift([]);
		expect(l.reps).toBe(0);
		expect(l.tokensSaved).toBe(0);
	});

	test("deltas are within-rep, then averaged; agreement counted", () => {
		const l = pairedLift([
			pair(0, { tokens: 100 }, { tokens: 300 }),
			pair(1, { tokens: 300 }, { tokens: 100 }),
			pair(2, { tokens: 100 }, { tokens: 200 }),
		]);
		expect(l.tokensSaved).toBeCloseTo(33.33, 2); // (200 - 200 + 100) / 3
		expect(l.tokensSavedReps).toBe(2);
	});

	test("correctness agreement allows ties", () => {
		const l = pairedLift([pair(0, { correct: 1 }, { correct: 1 })]);
		expect(l.correctNonNegReps).toBe(1);
	});
});

describe("paired cases", () => {
	test("condense: on-arm keeps spans, saves tokens, never loses correctness", () => {
		for (const p of runCase("condense")) {
			expect(p.on.correct).toBe(1);
			expect(p.off.correct).toBe(1);
			expect(p.on.tokens).toBeLessThan(p.off.tokens);
		}
	});

	test("condense: pure engine → identical reps (variance 0)", () => {
		const [a, b] = runCase("condense");
		expect(a?.on).toEqual(b?.on);
	});

	test("consult-contract: on-arm never scores below the off-arm", () => {
		for (const p of runCase("consult-contract")) {
			expect(p.on.correct).toBeGreaterThanOrEqual(p.off.correct);
		}
	});

	test("steer: drain cuts tokens every rep; cancel rep fixes correctness", () => {
		const pairs = runCase("steer-delivery");
		for (const p of pairs) {
			expect(p.on.tokens).toBeLessThan(p.off.tokens);
			expect(p.on.correct).toBeGreaterThanOrEqual(p.off.correct);
		}
		const cancel = pairs.find((p) => p.setup === "cancel@u3");
		expect(cancel?.on.correct).toBe(1);
		expect(cancel?.off.correct).toBe(0);
	});

	test("resume: bounded class wins the knob (cache-cheap, no rot)", () => {
		const v = resumePolicyVerdict();
		expect(v.bounded?.knob).toBe(true);
		for (const p of runCase("resume-bounded")) {
			expect(p.on.correct).toBeGreaterThanOrEqual(p.off.correct);
			expect(p.on.tokens).toBeLessThan(p.off.tokens);
			expect(p.on.minutes).toBeLessThan(p.off.minutes);
			expect(p.setup).toMatch(/^bounded@d\dm$/);
		}
	});

	test("resume: long class stays fresh (full-price read beats injection, rot)", () => {
		const v = resumePolicyVerdict();
		expect(v.long?.knob).toBe(false);
		for (const p of runCase("resume-long")) {
			expect(p.on.tokens).toBeGreaterThan(p.off.tokens);
			expect(p.on.correct).toBeLessThan(p.off.correct);
		}
	});

	test("every case runs the full REPS schedule", () => {
		for (const name of CASE_NAMES) {
			const pairs = runCase(name);
			expect(pairs.length).toBe(REPS);
			expect(pairs.map((p) => p.rep)).toEqual([0, 1, 2, 3]);
		}
	});
});

describe("paired harness", () => {
	test("all bench properties hold", () => {
		expect(checkProperties()).toEqual([]);
	});

	test("report is byte-identical across runs (no RNG)", () => {
		expect(formatReport()).toBe(formatReport());
	});

	test("runAll pairs lift with its pairs", () => {
		const reports = runAll();
		expect(reports.length).toBe(CASE_NAMES.length);
		for (const r of reports) {
			expect(r.pairs.length).toBe(REPS);
			expect(r.lift.reps).toBe(REPS);
		}
	});
});
