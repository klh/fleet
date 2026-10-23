// src/cost.ts — W1132 per-request cost: a versioned model price table plus
// the pure per-row computation the ledger applies at write time (Helicone
// pattern: every priced row stamps the rate version that computed it, so
// historical repricing is possible). Rates are OPERATOR CONFIG — the
// routing-policy.yaml `cost:` block — never code, never guessed in-repo:
//   a model without a rate row is cost-UNSUPPORTED (NULL, never silently
//   zero); a declared $0 rate is a legitimate stamped zero; an undeclared
//   cache discount bills cache tokens at the FULL input rate (no savings
//   claimed until the operator measures one — ZAI prefix caching stays
//   unpriced-as-savings until then).
import type { Usage } from "./usage.ts";

/** One model's rates (USD per token) + the shape switches the math needs. */
export interface CostModelRates {
	/** USD per input token. */
	in_per_tok: number;
	/** USD per output token. */
	out_per_tok: number;
	/** Multiplier on in_per_tok for cache-READ tokens. Absent = 1: the
	 *  conservative no-savings default (cache reads bill at full input
	 *  price until the operator declares the measured discount). */
	cache_read_mult?: number;
	/** Multiplier on in_per_tok for cache-WRITE tokens. Absent = 1. */
	cache_write_mult?: number;
	/** true = the provider's input token count INCLUDES the cached tokens
	 *  (OpenAI prompt_tokens shape — the cached subset bills at the cache
	 *  multiplier, the remainder at full rate); false/absent = cache tokens
	 *  are reported ADDITIVELY (Anthropic shape). */
	in_tok_includes_cache?: boolean;
}

/** routing-policy.yaml `cost:` block. `version` stamps every row this table
 *  prices; a table without a version prices NOTHING (cannot stamp, will not
 *  guess). */
export interface CostPolicy {
	version: string;
	models?: Record<string, CostModelRates>;
}

/** A priced row (cost + the version that computed it). null = unsupported:
 *  the ledger stores NULL / '' and every reader treats it as unknown spend,
 *  never zero. */
export type CostOf = { cost_usd: number; rate_version: string } | null;

/** Compute one usage row's cost against a table. Pure; null for an unpriced
 *  model or an unversioned table. */
export function computeCost(
	model: string,
	u: Usage,
	table: CostPolicy | null | undefined,
): CostOf {
	if (!table || typeof table.version !== "string" || table.version === "")
		return null;
	const rates = table.models?.[model];
	if (!rates || !validRates(rates)) return null;
	const inRate = rates.in_per_tok;
	const cached =
		rates.in_tok_includes_cache === true
			? Math.min(Math.max(u.cache_r, 0), Math.max(u.in_tok, 0))
			: Math.max(u.cache_r, 0);
	const directIn =
		rates.in_tok_includes_cache === true
			? Math.max(u.in_tok, 0) - cached
			: Math.max(u.in_tok, 0);
	const cost =
		directIn * inRate +
		Math.max(u.out_tok, 0) * rates.out_per_tok +
		cached * inRate * multOf(rates.cache_read_mult) +
		Math.max(u.cache_c, 0) * inRate * multOf(rates.cache_write_mult);
	return { cost_usd: cost, rate_version: table.version };
}

/** The ledger's price seam: model + usage → cost (null = unsupported). */
export type Pricer = (model: string, u: Usage) => CostOf;

/** Pricer for a table; the null table prices nothing (legacy-honest:
 *  columns stay NULL until the operator ships rates). */
export function pricerOf(table: CostPolicy | null | undefined): Pricer {
	return (model, u) => computeCost(model, u, table);
}

const multOf = (m: number | undefined): number =>
	typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 10 ? m : 1;

/** A rate row prices only when every declared number is a sane finite
 *  non-negative; multipliers are bounded [0,10]. An out-of-range row never
 *  prices (the buildCostPolicy parse is the loud gate — this is the
 *  read-time backstop). */
function validRates(r: CostModelRates): boolean {
	const num = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && v >= 0;
	if (!num(r.in_per_tok) || !num(r.out_per_tok)) return false;
	if (r.cache_read_mult !== undefined && !num(r.cache_read_mult)) return false;
	if (r.cache_write_mult !== undefined && !num(r.cache_write_mult))
		return false;
	return true;
}

/** Parse the `cost:` block off the policy doc — fail-CLOSED like
 *  provider_pools: a malformed table refuses startup loudly rather than
 *  silently unpricing models (the "never silently zero" law). */
export function buildCostPolicy(raw: unknown): CostPolicy | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw))
		throw new Error("policy: cost must be an object");
	const doc = raw as Record<string, unknown>;
	if (typeof doc.version !== "string" || doc.version === "")
		throw new Error(
			'policy: cost.version must be a non-empty string (it stamps every priced row — e.g. "rates-2026-10")',
		);
	const modelsRaw = doc.models;
	if (modelsRaw === undefined) return { version: doc.version };
	if (
		typeof modelsRaw !== "object" ||
		modelsRaw === null ||
		Array.isArray(modelsRaw)
	)
		throw new Error("policy: cost.models must be an object");
	const models: Record<string, CostModelRates> = {};
	for (const [model, entry] of Object.entries(
		modelsRaw as Record<string, unknown>,
	)) {
		if (typeof entry !== "object" || entry === null)
			throw new Error(`policy: cost.models."${model}" must be an object`);
		const e = entry as Record<string, unknown>;
		const num = (k: string): number => {
			const v = e[k];
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
				throw new Error(
					`policy: cost.models."${model}".${k} must be a finite non-negative number`,
				);
			return v;
		};
		const mult = (k: string): number | undefined => {
			const v = e[k];
			if (v === undefined) return undefined;
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10)
				throw new Error(
					`policy: cost.models."${model}".${k} must be a number in [0,10]`,
				);
			return v;
		};
		models[model] = {
			in_per_tok: num("in_per_tok"),
			out_per_tok: num("out_per_tok"),
			cache_read_mult: mult("cache_read_mult"),
			cache_write_mult: mult("cache_write_mult"),
			in_tok_includes_cache: e.in_tok_includes_cache === true,
		};
	}
	return { version: doc.version, models };
}
