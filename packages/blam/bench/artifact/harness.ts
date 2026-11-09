// bench/artifact/harness.ts — W2904 artifact-bench runner. Scenarios × arms
// (artifact refs) × reps over a bed driver; receipts are JSONL, one line per
// measurement, plus one summary line per scenario whose verdict block is
// REQUIRED (decision-grade law: every summary names a winner or an explicit
// tie). Same seed + same driver schedule → byte-identical receipts.
// Run: bun packages/blam/bench/artifact/harness.ts

import { type BedDriver, replayFixtureDriver, walkOrder } from "./drivers.ts";
import {
	type ArmRef,
	type ArmSamples,
	type Caps,
	computeVerdict,
	type ScenarioSpec,
	type Stat,
	statOf,
	type Verdict,
} from "./types.ts";

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

export interface ImageReceipt {
	kind: "image-identity";
	image: string;
	platform: string;
	imageId: string;
}

export type Receipt = ArmReceipt | SummaryReceipt | ImageReceipt;

function sampleStats(receipts: ArmReceipt[]) {
	const byArm = Map.groupBy(receipts, ({ arm }) => arm);
	const armSamples: ArmSamples[] = [...byArm].map(([arm, rows]) => ({
		arm,
		samples: rows.map(({ value }) => value),
	}));
	const stats: Record<string, Stat> = {};
	for (const { arm, samples } of armSamples)
		stats[arm] = {
			median: statOf(samples, "median"),
			p95: statOf(samples, "p95"),
		};
	return { armSamples, stats };
}

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
		} catch (e) {
			failures.push({
				arm: arm.id,
				rep,
				error: String((e as Error)?.message ?? e),
			});
		}
	}
	if (!armReceipts.length)
		throw new Error(`All artifact trials failed: ${JSON.stringify(failures)}`);
	const { armSamples, stats } = sampleStats(armReceipts);
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
export function receiptLines(
	run: ScenarioRun,
	images: ImageReceipt[] = [],
): string[] {
	return [...images, ...run.armReceipts, run.summary].map((r) =>
		JSON.stringify(r),
	);
}

/** Recompute the complete trial from sealed rows, without Docker or a model. */
export function replayReceipts(text: string) {
	const rows: Receipt[] = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const summary = rows.pop();
	if (
		summary?.kind !== "scenario-summary" ||
		!Number.isInteger(summary.reps) ||
		summary.reps < 1 ||
		!summary.verdict?.rule
	)
		throw new Error("Missing valid artifact summary");
	const samples = rows.filter(
		(row): row is ArmReceipt => row.kind === "arm-sample",
	);
	const images = rows.filter(
		(row): row is ImageReceipt => row.kind === "image-identity",
	);
	if (
		samples.length + images.length !== rows.length ||
		samples.some(
			(row) =>
				!Number.isFinite(row.value) ||
				row.value < 0 ||
				row.unit !== summary.unit ||
				row.scenario !== summary.scenario ||
				row.bed !== summary.bed ||
				row.seed !== summary.seed ||
				JSON.stringify(row.caps) !== JSON.stringify(summary.caps),
		)
	)
		throw new Error("Invalid or mismatched artifact samples");
	const { armSamples, stats } = sampleStats(samples);
	const arms = (
		images.length
			? images.map(({ image }) => image)
			: Object.keys(summary.stats)
	).map((id): ArmRef => ({ id, label: id, kind: "image", pinned: true }));
	const platform = ["aarch64", "arm64"].includes(summary.caps.arch)
		? "linux/arm64"
		: ["x86_64", "amd64"].includes(summary.caps.arch)
			? "linux/amd64"
			: undefined;
	if (
		arms.length < 2 ||
		new Set(arms.map(({ id }) => id)).size !== arms.length ||
		(images.length > 0 &&
			(images.some(
				({ image, platform: resolved, imageId }) =>
					!/@sha256:[a-f0-9]{64}$/.test(image) ||
					resolved !== platform ||
					!/^sha256:[a-f0-9]{64}$/.test(imageId),
			) ||
				samples.some(({ pinned }) => !pinned)))
	)
		throw new Error("Invalid artifact image identities");
	const spec: ScenarioSpec = {
		id: summary.scenario,
		title: summary.scenario,
		decision: summary.decision,
		seed: summary.seed,
		reps: summary.reps,
		rule: summary.verdict.rule,
		arms,
	};
	if (
		audit({ armReceipts: samples, summary, failures: [] }, spec).some(
			({ ok }) => !ok,
		) ||
		JSON.stringify(stats) !== JSON.stringify(summary.stats) ||
		JSON.stringify(computeVerdict(armSamples, spec.rule)) !==
			JSON.stringify(summary.verdict)
	)
		throw new Error("Artifact receipt replay mismatch");
	return { samples: samples.length, imageIdentities: images.length, summary };
}

/** decision-grade audit over a run: the properties every consumer may assume. */
export function audit(
	run: ScenarioRun,
	spec: ScenarioSpec,
): Array<{ prop: string; ok: boolean }> {
	const verdict = run.summary.verdict;
	const expected = new Set(
		walkOrder(spec.arms, spec.reps, spec.seed).map(({ arm, rep }) =>
			JSON.stringify([arm.id, rep]),
		),
	);
	const observations = [...run.armReceipts, ...run.failures];
	const matched = observations.map(({ arm, rep }) =>
		JSON.stringify([arm, rep]),
	);
	return [
		{ prop: "verdict-present", ok: typeof verdict?.winner === "string" },
		{
			prop: "verdict-decides",
			ok:
				verdict?.winner === "tied" ||
				Boolean(verdict && run.summary.stats[verdict.winner]),
		},
		{
			prop: "stats-total",
			ok: run.armReceipts.every(({ arm }) => {
				const stats = run.summary.stats[arm];
				return Number.isFinite(stats?.median) && Number.isFinite(stats?.p95);
			}),
		},
		{
			prop: "reps-accounted",
			ok:
				matched.length === expected.size &&
				new Set(matched).size === expected.size &&
				matched.every((key) => expected.has(key)),
		},
	];
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
	if (args[0] === "--replay") {
		if (args.length !== 2)
			throw new Error("usage: artifact harness --replay <receipts.ndjson>");
		const text = await Bun.file(args[1]).text();
		const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
		console.log(JSON.stringify({ sha256, ...replayReceipts(text) }));
		process.exit(0);
	}
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
	const identities: ImageReceipt[] = [];
	if (live)
		for (const { id } of arms)
			identities.push({
				kind: "image-identity",
				...(await dockerImageIdentity(driver.caps, id)),
			});
	const out = await runScenario(coldStartSpec(arms), driver);
	if (live && out.failures.length) {
		for (const row of [...identities, ...out.armReceipts])
			console.log(JSON.stringify(row));
		for (const failure of out.failures) console.error(JSON.stringify(failure));
		process.exitCode = 1;
	} else {
		for (const line of receiptLines(out, identities)) console.log(line);
	}

	if (live)
		console.error(
			`# live bed ${driver.bed} ${driver.caps.host}/${driver.caps.kernel}`,
		);
	else console.error("# replay-fixture (mechanics run, not ledger-grade)");
}
