import { expect, test } from "@playwright/test";
import { type RunnerReceipt, readReceipts } from "../bench/runner/contracts.ts";
import { distribution, evaluateRunner } from "../bench/runner/evaluate.ts";

function receipt(rep: number, arm: "baseline" | "candidate"): RunnerReceipt {
	return {
		version: 1,
		experiment: "seed-v1",
		track: "agentic",
		arm,
		rep,
		order: (arm === "baseline" ? rep % 2 : 1 - (rep % 2)) as 0 | 1,
		setup: {
			taskDigest: "task",
			repoRevision: "base",
			host: "fixture-host",
			runtime: "pi-pin",
			model: "model",
			provider: "hub",
			cacheCondition: "resident",
			policyDigest: "policy",
			dependenciesDigest: "deps",
			judgeDigest: "judge",
		},
		seedDigest: arm,
		jobId: `${rep}-${arm}`,
		readyMs: 5,
		firstUsefulMs: 8,
		wallMs: arm === "candidate" ? 10 : 20,
		rssBytes: null,
		diskBytes: null,
		usage: {
			input: arm === "candidate" ? 100 : 200,
			cachedInput: 50,
			output: 10,
		},
		quality: 1,
		exitCode: 0,
		timedOut: false,
		isolationFailures: 0,
		artifactDigest: "artifact",
		evidence: "fixture-only",
	};
}
const rows = () =>
	Array.from({ length: 12 }, (_, rep) => rep).flatMap((rep) => [
		receipt(rep, "baseline"),
		receipt(rep, "candidate"),
	]);

test.describe("runner refusal evidence @unit", () => {
	test("identical configurations only calibrate even with apparent timing gains", () => {
		const data = rows().map((r) => ({ ...r, seedDigest: "same" }));
		const report = evaluateRunner(data);
		expect(report.issues).toEqual([]);
		expect(report.controlOnly).toBe(true);
		expect(report.promotion.promote).toBe(false);
		expect(report.promotion.why).toContain("A/A");
	});
	for (const [name, mutate] of [
		[
			"missing usage",
			(r: RunnerReceipt[]) => {
				r[1].usage = null;
			},
		],
		[
			"wrong provider",
			(r: RunnerReceipt[]) => {
				r[1].setup.provider = "other";
			},
		],
		[
			"duplicate identity",
			(r: RunnerReceipt[]) => {
				r[1].jobId = r[0].jobId;
			},
		],
		[
			"quality regression",
			(r: RunnerReceipt[]) => {
				r[1].quality = 0.5;
			},
		],
		[
			"isolation failure",
			(r: RunnerReceipt[]) => {
				r[1].isolationFailures = 1;
			},
		],
		[
			"timeout",
			(r: RunnerReceipt[]) => {
				r[1].timedOut = true;
			},
		],
		[
			"missing useful",
			(r: RunnerReceipt[]) => {
				r[1].firstUsefulMs = null;
			},
		],
		[
			"wrong order",
			(r: RunnerReceipt[]) => {
				r[1].order = 0;
			},
		],
		[
			"seed drift",
			(r: RunnerReceipt[]) => {
				r[1].seedDigest = "unexpected";
			},
		],
		[
			"missing arm",
			(r: RunnerReceipt[]) => {
				r.pop();
			},
		],
	] as const) {
		test(`refuses ${name}`, () => {
			const data = rows();
			mutate(data);
			const result = evaluateRunner(data);
			expect(result.promotion.promote).toBe(false);
			expect(result.lift).toBeNull();
		});
	}
	test("infrastructure reports speed only without fabricated tokens", () => {
		const data = rows().map((r) => ({
			...r,
			track: "infrastructure" as const,
			usage: null,
		}));
		const result = evaluateRunner(data);
		expect(result.promotion.promote).toBe(true);
		expect(result.tokenSavingsMeasured).toBe(false);
		expect(result.arms.candidate.inputTokens.p50).toBeNull();
	});
});

test.describe("runner paired evidence @unit", () => {
	test("faster mean wall time cannot promote with a token regression", () => {
		const data = rows();
		for (const row of data) {
			if (row.arm === "candidate")
				row.usage = { input: 300, cachedInput: 50, output: 10 };
		}
		const result = evaluateRunner(data);
		expect(result.lift?.minutesSaved).toBeGreaterThan(0);
		expect(result.promotion).toEqual({
			promote: false,
			why: "mean token use regressed",
		});
	});

	test("faster mean wall time cannot promote with a p95 regression", () => {
		const data = rows();
		data[1].wallMs = 90;
		const result = evaluateRunner(data);
		expect(result.lift?.minutesSaved).toBeGreaterThan(0);
		expect(result.promotion).toEqual({
			promote: false,
			why: "p95 wall time regressed",
		});
	});

	test("smoke-size runs cannot promote", () => {
		const result = evaluateRunner(rows().slice(0, 6));
		expect(result.lift).not.toBeNull();
		expect(result.promotion.why).toContain("underpowered");
	});
	test("unknown isolation and cherry-picked repetitions refuse", () => {
		const missing = rows();
		missing[1].isolationFailures = null;
		expect(evaluateRunner(missing).issues.join()).toContain(
			"missing isolation",
		);
		const sparse = rows().map((r) => ({ ...r, rep: r.rep * 2 }));
		expect(evaluateRunner(sparse).promotion.promote).toBe(false);
	});
	test("NDJSON refuses impossible usage and malformed data", () => {
		const good = receipt(0, "baseline");
		expect(readReceipts(`${JSON.stringify(good)}\n`)).toHaveLength(1);
		expect(() =>
			readReceipts(
				JSON.stringify({
					...good,
					usage: { input: 1, cachedInput: 2, output: 0 },
				}),
			),
		).toThrow();
		expect(() => readReceipts("{broken")).toThrow();
		expect(() => evaluateRunner([])).toThrow("empty");
	});
	test("reuses paired lift without adding cached input twice", () => {
		const result = evaluateRunner(rows());
		expect(result.promotion.promote).toBe(true);
		expect(result.lift?.tokensSaved).toBe(100);
		expect(result.arms.candidate.wallMs.p95).toBe(10);
	});
	test("missing observations stay null in quantiles", () => {
		expect(distribution([null, 4, 10])).toEqual({
			measured: 2,
			missing: 1,
			p50: 4,
			p95: 10,
		});
		expect(distribution([null]).p50).toBeNull();
	});
});
