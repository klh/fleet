// test/cost.test.ts — W1132: the versioned price table + per-row cost
// computation. Unpriced = NULL (never zero); undeclared cache discount = no
// savings claimed (full input rate); version stamps every priced row.
import { describe, expect, test } from "bun:test";
import {
	buildCostPolicy,
	computeCost,
	pricerOf,
	type CostPolicy,
} from "../src/cost.ts";
import type { Usage } from "../src/usage.ts";

const U = (o: Partial<Usage>): Usage => ({
	in_tok: 0,
	out_tok: 0,
	cache_r: 0,
	cache_c: 0,
	...o,
});

const TABLE: CostPolicy = {
	version: "t1",
	models: {
		"m/full": { in_per_tok: 1e-6, out_per_tok: 3e-6 },
		"m/openai-shape": {
			in_per_tok: 1e-6,
			out_per_tok: 3e-6,
			in_tok_includes_cache: true,
		},
		"m/anthropic-shape": {
			in_per_tok: 1e-6,
			out_per_tok: 3e-6,
			cache_read_mult: 0.1,
			cache_write_mult: 1.25,
		},
		"m/free": { in_per_tok: 0, out_per_tok: 0 },
	},
};

describe("computeCost (W1132)", () => {
	test("unpriced model → null (never zero), even with tokens", () => {
		expect(computeCost("m/unknown", U({ in_tok: 5, out_tok: 5 }), TABLE)).toBe(
			null,
		);
	});

	test("no table → null (legacy-honest)", () => {
		expect(computeCost("m/full", U({ in_tok: 5 }), null)).toBe(null);
		expect(computeCost("m/full", U({ in_tok: 5 }), undefined)).toBe(null);
	});

	test("openai shape: cached subset bills at the multiplier, rest full", () => {
		// in_tok=100 includes cache_r=60 → 40 full + 60 at mult 1.0 (undeclared)
		const c = computeCost(
			"m/openai-shape",
			U({ in_tok: 100, out_tok: 10, cache_r: 60 }),
			TABLE,
		);
		expect(c).toEqual({
			cost_usd: 40 * 1e-6 + 60 * 1e-6 + 10 * 3e-6,
			rate_version: "t1",
		});
	});

	test("declared cache discount claims the savings", () => {
		const c = computeCost(
			"m/anthropic-shape",
			U({ in_tok: 100, out_tok: 10, cache_r: 200, cache_c: 40 }),
			TABLE,
		);
		// additive shape: 100 full + 200@0.1 + 40@1.25 + out
		expect(c?.rate_version).toBe("t1");
		expect(c?.cost_usd).toBeCloseTo(
			100e-6 + 200 * 0.1e-6 + 40 * 1.25e-6 + 10 * 3e-6,
			12,
		);
	});

	test("declared $0 rate is a stamped zero, distinct from unsupported", () => {
		const c = computeCost("m/free", U({ in_tok: 9, out_tok: 9 }), TABLE);
		expect(c).toEqual({ cost_usd: 0, rate_version: "t1" });
	});

	test("version stamps the row (repricing seam)", () => {
		const c = computeCost("m/full", U({ in_tok: 1 }), {
			version: "rates-2027",
			models: TABLE.models,
		});
		expect(c?.rate_version).toBe("rates-2027");
	});

	test("clamp: openai-shape cache_r > in_tok never goes negative", () => {
		const c = computeCost(
			"m/openai-shape",
			U({ in_tok: 10, cache_r: 99, out_tok: 1 }),
			TABLE,
		);
		// cached clamps to in_tok=10, direct=0
		expect(c).toEqual({ cost_usd: 10 * 1e-6 + 1 * 3e-6, rate_version: "t1" });
	});

	test("unversioned table prices nothing", () => {
		expect(
			computeCost("m/full", U({ in_tok: 1 }), { version: "", models: {} }),
		).toBe(null);
	});
});

describe("pricerOf (W1132)", () => {
	test("null table → null pricer", () => {
		expect(pricerOf(null)("m/full", U({ in_tok: 1 }))).toBe(null);
	});
	test("pricer honors the table", () => {
		expect(pricerOf(TABLE)("m/free", U({ in_tok: 2 }))).toEqual({
			cost_usd: 0,
			rate_version: "t1",
		});
	});
});

describe("buildCostPolicy (W1132, fail-closed parse)", () => {
	test("absent block → null", () => {
		expect(buildCostPolicy(undefined)).toBe(null);
		expect(buildCostPolicy(null)).toBe(null);
	});

	test("valid block parses, unknown fields dropped", () => {
		const p = buildCostPolicy({
			version: "v9",
			models: {
				x: {
					in_per_tok: 1,
					out_per_tok: 2,
					cache_read_mult: 0.5,
					in_tok_includes_cache: true,
					junk: "dropped",
				},
			},
		});
		expect(p).toEqual({
			version: "v9",
			models: {
				x: {
					in_per_tok: 1,
					out_per_tok: 2,
					cache_read_mult: 0.5,
					cache_write_mult: undefined,
					in_tok_includes_cache: true,
				},
			},
		});
	});

	test("models omitted → version-only table (prices nothing)", () => {
		expect(buildCostPolicy({ version: "v1" })).toEqual({ version: "v1" });
	});

	test.each([
		["non-object block", "nope"],
		["missing version", { models: {} }],
		["empty version", { version: "", models: {} }],
		["models not an object", { version: "v", models: [] }],
		["row not an object", { version: "v", models: { x: 3 } }],
		[
			"negative rate",
			{ version: "v", models: { x: { in_per_tok: -1, out_per_tok: 0 } } },
		],
		[
			"non-number rate",
			{ version: "v", models: { x: { in_per_tok: "1", out_per_tok: 0 } } },
		],
		[
			"mult out of range",
			{
				version: "v",
				models: { x: { in_per_tok: 0, out_per_tok: 0, cache_read_mult: 11 } },
			},
		],
	])("malformed: %s → throws", (_name, bad) => {
		expect(() => buildCostPolicy(bad)).toThrow();
	});
});
