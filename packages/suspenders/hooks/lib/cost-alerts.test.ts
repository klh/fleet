// hooks/lib/cost-alerts.test.ts — W1132 alert rules: budget thresholds,
// spike vs the 7d MA, outlier vs the median, the notify.yaml cost loader,
// and the ledger sweep inputs (legacy ledger → empty).
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	costSweepInputs,
	type CostHour,
	budgetAlerts,
	evaluateCostAlerts,
	loadCostConf,
	outlierAlert,
	spikeAlert,
} from "./cost-alerts.ts";

const hr = (bucket: string, costUsd: number | null): CostHour => ({
	bucket,
	costUsd,
});

const NOW = Date.parse("2026-10-23T14:30:00Z");

describe("budget alerts", () => {
	test("crosses fire ONE alert at the highest threshold", () => {
		expect(budgetAlerts(null, 10, "day")).toEqual([]);
		expect(budgetAlerts(4.4, 10, "day")).toEqual([]);
		const mid = budgetAlerts(5.1, 10, "day");
		expect(mid.length).toBe(1);
		expect(mid[0]?.severity).toBe("info");
		const high = budgetAlerts(8.2, 10, "day");
		expect(high.length).toBe(1);
		expect(high[0]?.severity).toBe("warn");
		const crit = budgetAlerts(9.6, 10, "day");
		expect(crit.length).toBe(1);
		expect(crit[0]?.severity).toBe("critical");
		expect(crit[0]?.key).toBe("budget-day-95");
	});
});

describe("spike alert", () => {
	const base = (n: number, cost: number | null): CostHour[] =>
		Array.from({ length: n }, (_, i) =>
			hr(
				`${new Date(NOW - (n - i) * 3_600_000).toISOString().slice(0, 13)}:00`,
				cost,
			),
		);

	test("current hour > 3x a real 7d baseline fires", () => {
		const hours = [...base(168, 0.02), hr("2026-10-23T14:00", 0.5)];
		const a = spikeAlert(hours);
		expect(a?.kind).toBe("spike");
		expect(a?.severity).toBe("warn");
	});

	test("noise floors keep quiet baselines quiet", () => {
		// baseline far below the arm floor: 3x of nothing is nothing
		expect(
			spikeAlert([...base(168, 0.001), hr("2026-10-23T14:00", 0.005)]),
		).toBeNull();
		// current hour unpriced → no spike eval
		expect(
			spikeAlert([...base(168, 0.02), hr("2026-10-23T14:00", null)]),
		).toBeNull();
		// too little history to call it a spike
		expect(
			spikeAlert([...base(10, 0.02), hr("2026-10-23T14:00", 9)]),
		).toBeNull();
	});
});

describe("outlier alert", () => {
	test("one huge call > 10x the median fires; small samples never arm", () => {
		const calls = Array.from({ length: 24 }, () => 0.01);
		expect(outlierAlert(calls)).toBeNull();
		expect(outlierAlert([...calls, 0.5])).not.toBeNull();
		expect(outlierAlert(Array.from({ length: 19 }, () => 0.01))).toBeNull();
	});
});

describe("evaluate + conf + sweep inputs", () => {
	test("evaluateCostAlerts composes the three rules (today/month prefix)", () => {
		const hours = [
			hr("2026-10-22T20:00", 9.0), // yesterday — out of the day sum
			hr("2026-10-23T12:00", 5.0), // today
			hr("2026-10-23T14:00", 0.2),
		];
		const alerts = evaluateCostAlerts({
			hours,
			calls: [],
			conf: { dailyBudgetUsd: 10, monthlyBudgetUsd: 20 },
			nowMs: NOW,
		});
		expect(alerts.some((a) => a.key === "budget-day-50")).toBe(true);
		// month sum = 9.0 + 5.0 + 0.2 = 14.2 of 20 → 71% → the 50% threshold
		expect(alerts.some((a) => a.key === "budget-month-50")).toBe(true);
		expect(alerts.some((a) => a.kind === "spike")).toBe(false); // no baseline
	});

	test("loadCostConf reads the notify.yaml cost block, malformed stays off", () => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-cost-conf-"));
		try {
			const p = join(dir, "notify.yaml");
			writeFileSync(
				p,
				"cost:\n  daily_budget_usd: 20\n  monthly_budget_usd: 400\n",
			);
			expect(loadCostConf(p)).toEqual({
				dailyBudgetUsd: 20,
				monthlyBudgetUsd: 400,
			});
			writeFileSync(p, "pulse:\n  interval_s: 60\n");
			expect(loadCostConf(p)).toBeNull();
			writeFileSync(p, "cost:\n  daily_budget_usd: -3\n");
			expect(loadCostConf(p)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("costSweepInputs: priced ledger yields hours; legacy yields empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-cost-sweep-"));
		try {
			const p = join(dir, "buckle.db");
			const d = new Database(p);
			d.run(
				"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, cost_usd REAL, rate_version TEXT DEFAULT '')",
			);
			d.run(
				"INSERT INTO router_usage (hour_bucket, cost_usd) VALUES ('2026-10-23T12:00', 0.5), ('2026-10-23T13:00', 0.25), ('2026-10-23T14:00', NULL)",
			);
			d.close();
			const r = costSweepInputs(p, { nowMs: NOW });
			expect(r.hours.length).toBe(3);
			expect(r.hours[2]?.costUsd).toBeNull();
			// legacy table without cost columns → empty, not a fake baseline
			const legacy = join(dir, "legacy.db");
			const l = new Database(legacy);
			l.run("CREATE TABLE router_usage (hour_bucket TEXT)");
			l.close();
			expect(costSweepInputs(legacy, { nowMs: NOW }).hours.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
