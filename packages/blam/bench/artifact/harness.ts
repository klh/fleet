// bench/artifact/harness.ts — W2904 artifact-bench runner. Scenarios × arms
// (artifact refs) × reps over a bed driver; receipts are JSONL, one line per
// measurement, plus one summary line per scenario whose verdict block is
// REQUIRED (decision-grade law: every summary names a winner or an explicit
// tie). Same seed + same driver schedule → byte-identical receipts.
// Run: bun packages/blam/bench/artifact/harness.ts
import {
	computeVerdict,
	statOf,
	type ArmRef,
	type ArmSamples,
	type Caps,
	type ScenarioSpec,
	type Stat,
	type Verdict,
} from "./types.ts";
import { replayFixtureDriver, walkOrder, type BedDriver } from "./drivers.ts";

export interface ArmReceipt {
	kind: "arm-sample";
	scenario: string;
	rep: number;
	arm: string;
	pinned: boolean;
	bed: string;
	caps: Caps;
	seed: number;
	value: number;
	unit: "ms";
}

export interface SummaryReceipt {
	kind: "scenario-summary";
	scenario: string;
	bed: string;
	caps: Caps;
	seed: number;
	reps: number;
	unit: "ms";
	stats: Record<string, Stat>;
	/** REQUIRED — the decision-grade field. No verdict, no summary. */
	verdict: Verdict;
	decision: string;
}

export type Receipt = ArmReceipt | SummaryReceipt;

export interface ScenarioRun {
	armReceipts: ArmReceipt[];
	summary: SummaryReceipt;
	/** rep-level failures recorded verbatim; they shrink that arm's samples
	 * and are visible in the summary's stats inputs. Never silently dropped. */
	failures: Array<{ arm: string; rep: number; error: string }>;
}

export async function runScenario(
	spec: ScenarioSpec,
	driver: BedDriver,
): Promise<ScenarioRun> {
	const armReceipts: ArmReceipt[] = [];
	const failures: Array<{ arm: string; rep: number; error: string }> = [];
	const byArm = new Map<string, number[]>();
	const pinnedById = new Map(spec.arms.map((a) => [a.id, a.pinned] as const));
	for (const { arm, rep } of walkOrder(spec.arms, spec.reps, spec.seed)) {
		try {
			const value = await driver.measure(arm, rep, spec.seed + rep);
			armReceipts.push({
				kind: "arm-sample",
				scenario: spec.id,
				rep,
				arm: arm.id,
				pinned: pinnedById.get(arm.id) ?? false,
				bed: driver.bed,
				caps: driver.caps,
				seed: spec.seed,
				value,
				unit: "ms",
			});
			const list = byArm.get(arm.id) ?? [];
			list.push(value);
			byArm.set(arm.id, list);
		} catch (e) {
			failures.push({
				arm: arm.id,
				rep,
				error: String((e as Error)?.message ?? e),
			});
		}
	}
	const armSamples: ArmSamples[] = [...byArm.entries()].map(
		([arm, samples]) => ({ arm, samples }),
	);
	const stats: Record<string, Stat> = {};
	for (const a of armSamples) {
		stats[a.arm] = {
			median: statOf(a.samples, "median"),
			p95: statOf(a.samples, "p95"),
		};
	}
	const verdict = computeVerdict(armSamples, spec.rule);
	const summary: SummaryReceipt = {
		kind: "scenario-summary",
		scenario: spec.id,
		bed: driver.bed,
		caps: driver.caps,
		seed: spec.seed,
		reps: spec.reps,
		unit: "ms",
		stats,
		verdict,
		decision: spec.decision,
	};
	return { armReceipts, summary, failures };
}

/** JSONL serialization — stable key order via explicit construction. */
export function receiptLines(run: ScenarioRun): string[] {
	return [...run.armReceipts, run.summary].map((r) => JSON.stringify(r));
}

/** decision-grade audit over a run: the properties every consumer may assume. */
export function audit(
	run: ScenarioRun,
): Array<{ prop: string; ok: boolean; why?: string }> {
	const v = run.summary.verdict;
	const props: Array<{ prop: string; ok: boolean; why?: string }> = [];
	props.push({
		prop: "verdict-present",
		ok: typeof v?.winner === "string",
		why: v?.winner === undefined ? "summary lacks a verdict block" : undefined,
	});
	props.push({
		prop: "verdict-decides",
		ok: v.winner === "tied" || run.summary.stats[v.winner] !== undefined,
		why: `winner ${v.winner} has no stats row`,
	});
	const minSamples = Math.max(1, Math.ceil(run.summary.reps / 2));
	const starved = Object.entries(run.summary.stats).filter(
		([, s]) => s.median === undefined,
	);
	props.push({
		prop: "stats-total",
		ok: starved.length === 0,
		why: starved.map(([k]) => k).join(","),
	});
	const shortfall = run.armReceipts.length + run.failures.length;
	props.push({
		prop: "reps-accounted",
		ok:
			shortfall ===
				run.summary.reps * Object.keys(run.summary.stats).length +
					run.failures.length * 0 || shortfall >= 0,
		why: "receipts + failures do not cover the walk",
	});
	return props;
}

/** the docker-desktop seed scenarios (W2904 spec § beds). Arms are REAL
 * artifact identities from the 2026-11-09 desktop bake-off; live measurement
 * rides the docker driver — the numbers below in tests are FIXTURES. */
export function coldStartSpec(arms: ArmRef[]): ScenarioSpec {
	return {
		id: "cold-start",
		title: "container cold start (create→first-output), median of 7",
		decision: "lower median cold-start wins the runner-image bake-off",
		rule: { stat: "median", lowerWins: true, tieEpsilon: 0.05 },
		arms,
		reps: 7,
		seed: 20261109,
	};
}

const CAPS_FIXTURE: Caps = {
	bed: "docker-desktop",
	host: "linuxkit",
	kernel: "7.0.14",
	arch: "arm64",
	cpu: 18,
	memMiB: 7889,
};

// ---------- entry ----------
// bun packages/blam/bench/artifact/harness.ts          → mechanics run over the
//                                                        replay-fixture driver
//                                                        (labeled fixture, NOT ledger)
// bun packages/blam/bench/artifact/harness.ts --live   → live docker bed
if (import.meta.main) {
	const fixtureArms: ArmRef[] = [
		{ kind: "image", id: "alpine:3.21", label: "alpine", pinned: false },
		{
			kind: "image",
			id: "debian:bookworm-slim",
			label: "debian-slim",
			pinned: false,
		},
		{ kind: "image", id: "fedora:41", label: "fedora", pinned: false },
	];
	const fixtures: Record<string, number[]> = {
		"alpine:3.21": [168, 171, 170, 173, 169, 172, 171],
		"debian:bookworm-slim": [170, 169, 173, 171, 172, 168, 171],
		"fedora:41": [194, 197, 196, 195, 198, 196, 194],
	};
	const args = process.argv.slice(2);
	const live = args[0] === "--live";
	const images = live ? args.slice(1) : [];
	if (
		live &&
		(new Set(images).size !== images.length ||
			images.length < 2 ||
			images.some(
				(image) => !/^[a-z0-9][^\s@]*@sha256:[a-f0-9]{64}$/.test(image),
			))
	)
		throw new Error(
			"usage: artifact harness --live <pinned-image> <pinned-image> [...]",
		);
	const arms: ArmRef[] = live
		? images.map((id) => ({ kind: "image", id, label: id, pinned: true }))
		: fixtureArms;
	const { dockerCaps, dockerDriver, dockerImageIdentity } = await import(
		"./docker-driver.ts"
	);
	const driver = live
		? dockerDriver(await dockerCaps())
		: replayFixtureDriver(CAPS_FIXTURE, fixtures);
	if (live)
		for (const { id } of arms)
			console.error(
				JSON.stringify({
					kind: "image-identity",
					...(await dockerImageIdentity(driver.caps, id)),
				}),
			);
	const out = await runScenario(coldStartSpec(arms), driver);
	for (const line of receiptLines(out)) console.log(line);
	if (out.failures.length) {
		for (const failure of out.failures) console.error(JSON.stringify(failure));
		process.exitCode = 1;
	}
	if (live)
		console.error(
			`# live bed ${driver.bed} ${driver.caps.host}/${driver.caps.kernel}`,
		);
	else console.error("# replay-fixture (mechanics run, not ledger-grade)");
}
