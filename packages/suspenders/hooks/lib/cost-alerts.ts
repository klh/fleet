// hooks/lib/cost-alerts.ts — W1132 cost alerts: three trip rules over the
// buckle ledger's PRICED rows, pure so any sweep can evaluate them. Rates
// are operator conf; a row without pricing is unknown spend — the rules
// arm on priced history only and never read NULL as 0.
//   budget: today's/month's priced spend vs notify.yaml cost.daily_budget_usd
//           / monthly_budget_usd — one alert at the HIGHEST crossed
//           threshold of 50/80/95% (info/warn/critical).
//   spike:  the current hour's priced spend > 3x the 7-day moving average
//           (llm-academy pattern — would have caught the W1078/W1068 burst
//           era), armed only when the MA is a real baseline (>= $0.01/h).
//   outlier: one call costing > 10x the median of the recent priced calls,
//           armed at >= 20 samples and >= $0.01 (a retry loop shows up as
//           many median-sized calls; this catches the one huge call).
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { NOTIFY_PATH } from "./notify.ts";
import { hasCostCol, resolveBuckleDb } from "./lane-spend.ts";
import { parse } from "yaml";

export interface CostHour {
	bucket: string; // "YYYY-MM-DDTHH:00" UTC, ascending
	costUsd: number | null;
}

export interface CostAlertConf {
	dailyBudgetUsd?: number;
	monthlyBudgetUsd?: number;
}

export interface CostAlert {
	kind: "budget" | "spike" | "outlier";
	severity: "info" | "warn" | "critical";
	/** stable dedupe key (notify class policy consumes it) */
	key: string;
	note: string;
}

/** Budget trip thresholds: one alert at the HIGHEST crossed threshold. */
export const BUDGET_THRESHOLDS: Array<{
	pct: number;
	severity: "info" | "warn" | "critical";
}> = [
	{ pct: 50, severity: "info" },
	{ pct: 80, severity: "warn" },
	{ pct: 95, severity: "critical" },
];

/** The spike/outlier arms: below these the rule reads noise, never spend. */
export const SPIKE_MULT = 3;
export const SPIKE_FLOOR_USD = 0.01;
export const OUTLIER_MULT = 10;
export const OUTLIER_MIN_SAMPLES = 20;
export const OUTLIER_FLOOR_USD = 0.01;

const money = (n: number): string =>
	n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

/** The priced sum over the buckets matching `prefix` (day or month);
 *  null = nothing priced matched (unknown spend, not zero). */
const pricedSum = (rows: CostHour[], prefix: string): number | null => {
	let sum: number | null = null;
	for (const h of rows) {
		if (!h.bucket.startsWith(prefix)) continue;
		sum = h.costUsd === null ? sum : (sum ?? 0) + h.costUsd;
	}
	return sum;
};

/** Pure budget rule: one alert at the highest crossed 50/80/95 threshold. */
export function budgetAlerts(
	spent: number | null,
	limit: number,
	scope: "day" | "month",
): CostAlert[] {
	if (spent === null || !(limit > 0)) return [];
	const pct = (spent / limit) * 100;
	let best: { pct: number; severity: "info" | "warn" | "critical" } | null =
		null;
	for (const t of BUDGET_THRESHOLDS) if (pct >= t.pct) best = t;
	if (!best) return [];
	return [
		{
			kind: "budget",
			severity: best.severity,
			key: `budget-${scope}-${best.pct}`,
			note: `${scope === "day" ? "Daily" : "Monthly"} budget ${Math.round(pct)}% used: ${money(spent)} of ${money(limit)}`,
		},
	];
}

/** Spike rule: current-hour priced spend > 3x the 7d MA (priced buckets
 *  only, null = skip in the average), armed when the MA >= $0.01/h AND the
 *  hour itself >= $0.01 — a real spike on a real baseline, not noise. */
export function spikeAlert(hours: CostHour[]): CostAlert | null {
	const cur = hours[hours.length - 1];
	if (!cur || cur.costUsd === null) return null;
	const prior = hours.slice(0, -1).slice(-168);
	if (prior.length < 24) return null;
	const priced = prior
		.map((h) => h.costUsd)
		.filter((v): v is number => v !== null);
	if (priced.length === 0) return null;
	const ma = priced.reduce((a, b) => a + b, 0) / priced.length;
	if (ma < SPIKE_FLOOR_USD) return null;
	if (!(cur.costUsd > SPIKE_MULT * ma) || cur.costUsd < SPIKE_FLOOR_USD)
		return null;
	return {
		kind: "spike",
		severity: "warn",
		key: `spike-${cur.bucket}`,
		note: `Hourly spend ${money(cur.costUsd)} is ${SPIKE_MULT}x+ the 7d average (${money(ma)}/h) — retry loop or burst?`,
	};
}

/** Outlier rule: one call > 10x the median of the recent priced calls,
 *  armed at >= 20 samples and >= $0.01 (a retry loop shows up as many
 *  median-sized calls; this catches the one huge call). */
export function outlierAlert(calls: number[]): CostAlert | null {
	if (calls.length < OUTLIER_MIN_SAMPLES) return null;
	const sorted = [...calls].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	if (!(median > 0)) return null;
	const max = sorted[sorted.length - 1];
	if (!(max > OUTLIER_MULT * median) || max < OUTLIER_FLOOR_USD) return null;
	return {
		kind: "outlier",
		severity: "warn",
		key: `outlier-${max.toFixed(6)}`,
		note: `One call cost ${money(max)} — ${OUTLIER_MULT}x+ the ${money(median)} median of the last ${calls.length} priced calls`,
	};
}

/** The sweep entry: evaluate all three rules. Budgets ride notify.yaml
 *  cost.daily_budget_usd / cost.monthly_budget_usd (machine conf; absent →
 *  that rule stays off — never invent a budget). */
export function evaluateCostAlerts(input: {
	hours: CostHour[];
	calls: number[];
	conf?: CostAlertConf | null;
	nowMs?: number;
}): CostAlert[] {
	const nowMs = input.nowMs ?? Date.now();
	const today = new Date(nowMs).toISOString().slice(0, 10);
	const out: CostAlert[] = [];
	if (input.conf?.dailyBudgetUsd !== undefined)
		out.push(
			...budgetAlerts(
				pricedSum(input.hours, today),
				input.conf.dailyBudgetUsd,
				"day",
			),
		);
	if (input.conf?.monthlyBudgetUsd !== undefined)
		out.push(
			...budgetAlerts(
				pricedSum(input.hours, today.slice(0, 7)),
				input.conf.monthlyBudgetUsd,
				"month",
			),
		);
	const spike = spikeAlert(input.hours);
	if (spike) out.push(spike);
	const outlier = outlierAlert(input.calls);
	if (outlier) out.push(outlier);
	return out;
}

/** notify.yaml `cost:` block (machine conf, never code). A malformed or
 *  absent budget leaves the rule OFF — null = no budgets configured. */
export function loadCostConf(
	path: string = NOTIFY_PATH(),
): CostAlertConf | null {
	let raw: unknown;
	try {
		raw = parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const cost = (raw as Record<string, unknown>).cost;
	if (!cost || typeof cost !== "object") return null;
	const num = (k: string): number | undefined => {
		const v = (cost as Record<string, unknown>)[k];
		return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
	};
	const dailyBudgetUsd = num("daily_budget_usd");
	const monthlyBudgetUsd = num("monthly_budget_usd");
	if (dailyBudgetUsd === undefined && monthlyBudgetUsd === undefined)
		return null;
	return { dailyBudgetUsd, monthlyBudgetUsd };
}

/** All-lane hourly priced cost from router_usage (keyless lanes count).
 *  Legacy ledgers yield empty — never a fake baseline. */
export function costSweepInputs(
	dbPath: string,
	opts: { nowMs?: number; days?: number } = {},
): { hours: CostHour[]; calls: number[] } {
	const nowMs = opts.nowMs ?? Date.now();
	const windowDays = opts.days ?? 8;
	const fromBucket = `${new Date(nowMs - windowDays * 86_400_000)
		.toISOString()
		.slice(0, 13)}:00`;
	const d = new Database(dbPath, { readonly: true });
	try {
		if (!hasCostCol(d, "router_usage")) return { hours: [], calls: [] };
		const hours = d
			.query(
				`SELECT hour_bucket AS bucket, SUM(cost_usd) AS cost
				 FROM router_usage WHERE hour_bucket >= ?
				 GROUP BY hour_bucket ORDER BY hour_bucket`,
			)
			.all(fromBucket) as Array<{ bucket: string; cost: number | null }>;
		return {
			hours: hours.map((h) => ({
				bucket: String(h.bucket),
				costUsd: h.cost === null ? null : Number(h.cost),
			})),
			calls: [],
		};
	} catch {
		return { hours: [], calls: [] };
	} finally {
		d.close();
	}
}

/** One-line human render for a sweep (bin output + pulse line). */
export function renderCostAlert(a: CostAlert): string {
	return `${a.severity.toUpperCase()} ${a.kind}: ${a.note}`;
}

/** The pulse provider: sweep the ledger, render alerts as one-liners.
 *  Fail-soft — no ledger or any sweep error → empty (the pulse section is
 *  absent, never fake). */
export function readCostLines(): string[] {
	const ledger = resolveBuckleDb();
	if (!ledger) return [];
	try {
		const { hours, calls } = costSweepInputs(ledger);
		return evaluateCostAlerts({ hours, calls, conf: loadCostConf() }).map(
			renderCostAlert,
		);
	} catch {
		return [];
	}
}
