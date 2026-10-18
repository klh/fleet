// w745-routing-bench.test.ts — bench-routing.ts core: arm math, scaling,
// choice, $ pricing and the abstain rule, on synthetic windows.
import { describe, expect, test } from "bun:test";
import {
	analyze,
	percentile,
	type GateRow,
	type LogRow,
} from "../bin/bench-routing.ts";

const gate = (
	ts: string,
	port: number,
	tier: string,
	ok: 0 | 1,
	durationMs: number,
): GateRow => ({ ts, port, tier, ok, durationMs, model: "glm-5.3-flash" });

const log = (
	port: number,
	durationMs: number,
	error = false,
): LogRow => ({
	ts: "2026-10-15T00:00:00Z",
	port,
	durationMs,
	complexity: 0.5,
	tier: "MEDIUM",
	escalated: null,
	error,
});

const TOK = { model: "glm-5.3-flash", cloudIn: 1e6, cloudOut: 0.5e6 };
const PRICES = { "glm-5.3-flash": { in: 1, out: 2 } };

describe("w745 routing bench", () => {
	test("percentile is nearest-rank", () => {
		expect(percentile([1, 2, 3, 4], 0.5) === 3).toBe(true);
		expect(percentile([1, 2, 3, 4], 0.9) === 4).toBe(true);
		expect(Number.isNaN(percentile([], 0.5))).toBe(true);
	});

	test("audited arm reports real outcomes", () => {
		const g: GateRow[] = [];
		for (let i = 0; i < 60; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4100, "MEDIUM", 1, 5000));
		for (let i = 0; i < 10; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4000, "SIMPLE", 1, 150));
		const rep = analyze(g, [log(8903, 1000)], { tokens: TOK });
		const a = rep.arms[0];
		expect(a.name.startsWith("complexity-v3")).toBe(true);
		expect(a.requests === 70).toBe(true);
		expect(a.completed === 70).toBe(true);
		expect(a.localPct === (100 * 10) / 70).toBe(true);
		expect(a.latencyP50Ms === 5000).toBe(true);
	});

	test("fixed:cloud scales tokens by the request share", () => {
		const g: GateRow[] = [];
		for (let i = 0; i < 30; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4100, "MEDIUM", 1, 5000));
		for (let i = 0; i < 40; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4000, "SIMPLE", 1, 150));
		const rep = analyze(g, [log(8903, 1000)], { tokens: TOK });
		const fc = rep.arms.find((x) => x.name.includes("fixed:cloud"));
		expect(fc !== undefined).toBe(true);
		if (!fc) return;
		expect(fc.cloudInTok === 1e6 * (70 / 30)).toBe(true);
		expect(fc.localPct === 0).toBe(true);
		expect(rep.choice.arm.includes("complexity")).toBe(true);
	});

	test("pricing: abstain without prices, claim with them", () => {
		const g: GateRow[] = [];
		for (let i = 0; i < 40; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4100, "MEDIUM", 1, 5000));
		const rep = analyze(g, [log(8903, 1000)], { tokens: TOK });
		expect(rep.arms[0].costUsd === undefined).toBe(true);
		const rep2 = analyze(g, [log(8903, 1000)], {
			tokens: TOK,
			prices: PRICES,
		});
		const a2 = rep2.arms[0];
		expect(a2.costUsd === 2).toBe(true);
		expect(a2.per1kCompletedUsd === 50).toBe(true);
		expect(rep2.choice.why.includes("USD")).toBe(true);
	});

	test("window floor enforced", () => {
		expect(() => analyze([], [])).toThrow();
	});

	test("fixed:reason is reported but excluded from the choice", () => {
		const g: GateRow[] = [];
		for (let i = 0; i < 40; i++)
			g.push(gate("2026-10-15T00:00:00Z", 4100, "MEDIUM", 1, 5000));
		const rep = analyze(g, [log(8903, 1000)], { tokens: TOK });
		const fr = rep.arms.find((x) => x.name.includes("fixed:reason"));
		expect(fr !== undefined).toBe(true);
		if (!fr) return;
		expect(fr.eligible === false).toBe(true);
		expect(fr.why.length > 0).toBe(true);
		expect(rep.choice.arm.includes("complexity")).toBe(true);
	});
});
