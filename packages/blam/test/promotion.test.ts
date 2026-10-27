// test/promotion.test.ts — W458.5: promotion evals + rollback authority.
// Covered: the gate takes a measured Lift (self-reported confidence cannot
// reach it), underpowered/regression/no-benefit/no-sign-agreement refusals,
// real pairedLift promotion, rollback target resolution (newest prior,
// refusals observable).
import { describe, expect, test } from "bun:test";
import {
	gatePromotion,
	rollbackTargetOf,
	type VersionRef,
} from "../src/promotion.ts";
import { pairedLift } from "../bench/paired/types.ts";

const winPairs = (): Parameters<typeof pairedLift>[0] => [
	{
		rep: 1,
		setup: "s",
		on: { correct: 0.9, tokens: 1000, minutes: 5 },
		off: { correct: 0.9, tokens: 11_000, minutes: 25 },
	},
	{
		rep: 2,
		setup: "s",
		on: { correct: 0.95, tokens: 900, minutes: 4 },
		off: { correct: 0.9, tokens: 10_500, minutes: 24 },
	},
	{
		rep: 3,
		setup: "s",
		on: { correct: 0.85, tokens: 1100, minutes: 5 },
		off: { correct: 0.85, tokens: 9800, minutes: 23 },
	},
];

describe("blam promotion gate", () => {
	test("measured win promotes — real pairedLift, decision-grade", () => {
		const d = gatePromotion(pairedLift(winPairs()));
		expect(d.promote).toBe(true);
	});

	test("underpowered refuses", () => {
		const d = gatePromotion(pairedLift(winPairs().slice(0, 2)));
		expect(d.promote).toBe(false);
		expect(d.why).toMatch(/underpowered/);
	});

	test("correctness regression refuses", () => {
		const pairs = winPairs();
		pairs[0].on.correct = 0.5;
		const d = gatePromotion(pairedLift(pairs));
		expect(d.promote).toBe(false);
		expect(d.why).toMatch(/regression/);
	});

	test("no measured benefit refuses", () => {
		const pairs = winPairs().map((p) => ({
			...p,
			on: { correct: p.on.correct, tokens: 10_000, minutes: 10 },
			off: { correct: p.off.correct, tokens: 10_000, minutes: 10 },
		}));
		const d = gatePromotion(pairedLift(pairs));
		expect(d.promote).toBe(false);
		expect(d.why).toMatch(/no measured benefit/);
	});

	test("one lucky rep cannot carry the mean (sign agreement)", () => {
		const pairs = winPairs().map((p, i) =>
			i === 0 ? p : { ...p, on: { ...p.on, tokens: p.off.tokens + 500 } },
		);
		const d = gatePromotion(pairedLift(pairs));
		expect(d.promote).toBe(false);
		expect(d.why).toMatch(/sign agreement/);
	});
});
describe("blam rollback authority", () => {
	const versions: VersionRef[] = [
		{ version: 1, digest: "aaa", createdAt: "2026-10-01T00:00:00.000Z" },
		{ version: 2, digest: "bbb", createdAt: "2026-10-02T00:00:00.000Z" },
		{ version: 3, digest: "ccc", createdAt: "2026-10-03T00:00:00.000Z" },
	];

	test("rollback target = newest prior version", () => {
		const plan = rollbackTargetOf("starter-a", versions, 3);
		if ("refused" in plan) throw new Error("expected a plan");
		expect(plan.to).toBe(2);
		expect(plan.fromDigest).toBe("ccc");
		expect(plan.toDigest).toBe("bbb");
	});

	test("no prior version = observable refusal", () => {
		const plan = rollbackTargetOf("starter-a", versions, 1);
		expect("refused" in plan).toBe(true);
		if ("refused" in plan) expect(plan.refused).toMatch(/no rollback target/);
	});

	test("unknown candidate version refused", () => {
		expect("refused" in rollbackTargetOf("starter-a", versions, 9)).toBe(true);
	});
});
