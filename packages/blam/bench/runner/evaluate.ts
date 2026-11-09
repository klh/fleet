import { gatePromotion } from "../../src/promotion.ts";
import { pairedLift, type PairedRep } from "../paired/types.ts";
import { RunnerReceiptSchema, type RunnerReceipt } from "./contracts.ts";

/** Nearest-rank quantiles; null is missing, never a zero sample. */
export function distribution(values: (number | null)[]) {
	const sorted = values
		.filter((v): v is number => v !== null)
		.sort((a, b) => a - b);
	const at = (q: number) =>
		sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
	return {
		measured: sorted.length,
		missing: values.length - sorted.length,
		p50: at(0.5),
		p95: at(0.95),
	};
}

/** Only produces advice. It never changes a seed channel or installed policy. */
export function evaluateRunner(input: RunnerReceipt[]) {
	const rows = input.map((r) => RunnerReceiptSchema.parse(r));
	const issues: string[] = [];
	const first = rows[0];
	if (!first) throw new Error("empty runner experiment");
	const groups = new Map<number, RunnerReceipt[]>();
	const jobs = new Set<string>();
	for (const row of rows) {
		if (row.experiment !== first.experiment || row.track !== first.track)
			issues.push("mixed experiments or tracks");
		if (JSON.stringify(row.setup) !== JSON.stringify(first.setup))
			issues.push(`unmatched setup at rep ${row.rep}`);
		if (jobs.has(row.jobId)) issues.push(`reused job identity: ${row.jobId}`);
		jobs.add(row.jobId);
		groups.set(row.rep, [...(groups.get(row.rep) ?? []), row]);
	}
	const pairs: PairedRep[] = [];
	for (const [rep, group] of groups) {
		const off = group.find((r) => r.arm === "baseline");
		const on = group.find((r) => r.arm === "candidate");
		if (group.length !== 2 || !off || !on) {
			issues.push(`missing or duplicate arm at rep ${rep}`);
			continue;
		}
		if (off.order !== rep % 2 || on.order !== 1 - (rep % 2))
			issues.push(`non-counterbalanced order at rep ${rep}`);
		for (const row of group) {
			if (row.track === "agentic" && row.isolationFailures === null)
				issues.push(`missing isolation telemetry at rep ${rep} ${row.arm}`);
			if (
				row.exitCode !== 0 ||
				row.timedOut ||
				(row.isolationFailures ?? 0) > 0
			)
				issues.push(`failed execution or isolation at rep ${rep} ${row.arm}`);
			if (row.readyMs === null || row.firstUsefulMs === null)
				issues.push(`missing startup telemetry at rep ${rep} ${row.arm}`);
			if (
				row.track === "agentic" &&
				(!row.usage || row.usage.input + row.usage.output <= 0)
			)
				issues.push(`missing model usage at rep ${rep} ${row.arm}`);
		}
		if (on.quality !== 1 || on.quality < off.quality)
			issues.push(`candidate quality failure at rep ${rep}`);
		const tokens = (r: RunnerReceipt) =>
			r.track === "agentic" && r.usage ? r.usage.input + r.usage.output : 0;
		pairs.push({
			rep,
			setup: JSON.stringify(first.setup),
			off: {
				correct: off.quality,
				tokens: tokens(off),
				minutes: off.wallMs / 60_000,
			},
			on: {
				correct: on.quality,
				tokens: tokens(on),
				minutes: on.wallMs / 60_000,
			},
		});
	}
	if (groups.size < 3)
		issues.push("underpowered: need at least three matched repetitions");
	for (const arm of ["baseline", "candidate"] as const) {
		if (
			new Set(rows.filter((r) => r.arm === arm).map((r) => r.seedDigest)).size >
			1
		)
			issues.push(`seed changed within ${arm} arm`);
	}
	if ([...groups.keys()].sort((a, b) => a - b).some((rep, i) => rep !== i))
		issues.push("non-contiguous repetitions");
	const lift = issues.length ? null : pairedLift(pairs);
	let promotion = lift
		? gatePromotion(lift, { minReps: 12, maxCorrectRegression: 0 })
		: { promote: false, why: issues.join("; ") };
	if (
		lift &&
		promotion.promote &&
		lift.minutesSaved > 0 &&
		lift.minutesSavedReps * 2 <= lift.reps
	)
		promotion = {
			promote: false,
			why: "no wall-time sign agreement across repetitions",
		};
	if (lift && promotion.promote) {
		const regressions: string[] = [];
		if (first.track === "agentic" && lift.tokensSaved < 0)
			regressions.push("mean token use regressed");
		const baselineP95 = distribution(pairs.map((pair) => pair.off.minutes)).p95;
		const candidateP95 = distribution(pairs.map((pair) => pair.on.minutes)).p95;
		if (
			baselineP95 !== null &&
			candidateP95 !== null &&
			candidateP95 > baselineP95
		)
			regressions.push("p95 wall time regressed");
		if (regressions.length)
			promotion = { promote: false, why: regressions.join("; ") };
	}
	return {
		experiment: first.experiment,
		track: first.track,
		issues: [...new Set(issues)],
		pairs,
		lift,
		promotion,
		tokenSavingsMeasured: first.track === "agentic" && lift !== null,
		arms: Object.fromEntries(
			(["baseline", "candidate"] as const).map((arm) => {
				const subset = rows.filter((r) => r.arm === arm);
				return [
					arm,
					{
						runs: subset.length,
						failures: subset.filter(
							(r) => r.exitCode !== 0 || r.timedOut || r.quality !== 1,
						).length,
						isolationFailures: distribution(
							subset.map((r) => r.isolationFailures),
						),
						readyMs: distribution(subset.map((r) => r.readyMs)),
						firstUsefulMs: distribution(subset.map((r) => r.firstUsefulMs)),
						wallMs: distribution(subset.map((r) => r.wallMs)),
						rssBytes: distribution(subset.map((r) => r.rssBytes)),
						diskBytes: distribution(subset.map((r) => r.diskBytes)),
						inputTokens: distribution(
							subset.map((r) => r.usage?.input ?? null),
						),
						cachedInputTokens: distribution(
							subset.map((r) => r.usage?.cachedInput ?? null),
						),
						outputTokens: distribution(
							subset.map((r) => r.usage?.output ?? null),
						),
					},
				];
			}),
		),
	};
}
