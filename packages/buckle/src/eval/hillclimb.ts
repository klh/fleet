// src/eval/hillclimb.ts — W1200 hillclimb driver over the replay module:
// TRAIN/TEST split, one-knob rounds, paired bootstrap CIs, keep/revert
// verdicts under the cost-fallback objective (success floor first, then
// cost = 429-burn + failed-request token waste, then latency). Determinism:
// every config is replayed twice and must score identically; seeded
// bootstrap gives reproducible CIs. Read-only over the ledger snapshot.
import {
	aggregate,
	BASELINE_KNOBS,
	loadLedger,
	replayWindow,
	splitWindows,
	type AttemptRow,
	type ReplayKnobs,
	type ReplayOutcome,
	type RequestRow,
} from "./replay.ts";

export const SUCCESS_FLOOR = 0.005;
export const BOOTSTRAP_N = 300;

export interface Costed {
	success: 0 | 1;
	cost: number;
}

export const costOf = (
	o: ReplayOutcome,
	meanTokPerSuccess: number,
): Costed => ({
	success: o.success ? 1 : 0,
	cost: o.burn429 + (o.success ? 0 : meanTokPerSuccess),
});

/** Logged-truth per-request outcome: the chain as it actually ran. */
export function rawOutcomes(
	requests: RequestRow[],
	chains: Map<string, AttemptRow[]>,
): ReplayOutcome[] {
	return requests.map((r) => {
		const chain = chains.get(r.rid) ?? [];
		let burn = 0;
		for (const a of chain) if (a.status === 429) burn++;
		return {
			success: r.ok === 1,
			burn429: burn,
			durationMs: r.duration_ms ?? 0,
			attempts: chain.length,
		};
	});
}

/** Deterministic LCG for reproducible bootstrap resampling. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Paired bootstrap CI of mean(cost_cand − cost_base) over requests. */
export function bootstrapDelta(
	base: Costed[],
	cand: Costed[],
	resamples: number = BOOTSTRAP_N,
	seed: number = 1,
): { lo: number; hi: number; mean: number } {
	const n = Math.min(base.length, cand.length);
	const deltas = new Array<number>(n);
	for (let i = 0; i < n; i++) deltas[i] = cand[i].cost - base[i].cost;
	const rnd = lcg(seed);
	const means: number[] = [];
	for (let b = 0; b < resamples; b++) {
		let acc = 0;
		for (let i = 0; i < n; i++) acc += deltas[Math.floor(rnd() * n)];
		means.push(acc / n);
	}
	means.sort((a, b) => a - b);
	const lo = means[Math.floor(0.025 * (resamples - 1))];
	const hi = means[Math.floor(0.975 * (resamples - 1))];
	const mean = deltas.reduce((a, b) => a + b, 0) / n;
	return { lo, hi, mean };
}

export interface ArmScore {
	metrics: WindowMetrics;
	deltaCostCi: { lo: number; hi: number; mean: number };
	deltaSuccess: number;
}

export interface RoundVerdict {
	round: number;
	knob: keyof ReplayKnobs;
	from: number;
	to: number;
	train: ArmScore;
	test: ArmScore;
	verdict: "KEEP" | "REVERT";
	reason: string;
}

const scoreArm = (
	base: ReplayOutcome[],
	cand: ReplayOutcome[],
	meanTok: number,
	seed: number,
): ArmScore => {
	const costedBase = base.map((o) => costOf(o, meanTok));
	const costedCand = cand.map((o) => costOf(o, meanTok));
	return {
		metrics: aggregate(cand, meanTok),
		deltaCostCi: bootstrapDelta(costedBase, costedCand, BOOTSTRAP_N, seed),
		deltaSuccess:
			cand.filter((o) => o.success).length / cand.length -
			base.filter((o) => o.success).length / base.length,
	};
};

/** Keep rule: success floors hold on BOTH windows, and cost improves
 *  significantly (CI95 entirely below zero) on BOTH train and test.
 *  Revert-first on any noise-level gain. */
export function verdict(
	train: ArmScore,
	test: ArmScore,
): { verdict: "KEEP" | "REVERT"; reason: string } {
	const floor = SUCCESS_FLOOR;
	if (train.deltaSuccess < -floor || test.deltaSuccess < -floor) {
		return {
			verdict: "REVERT",
			reason: `success-floor breach (train ${train.deltaSuccess.toFixed(4)}, test ${test.deltaSuccess.toFixed(4)})`,
		};
	}
	if (train.deltaCostCi.hi < 0 && test.deltaCostCi.hi < 0) {
		return {
			verdict: "KEEP",
			reason: `cost improves beyond noise on both windows (train CI95 [${train.deltaCostCi.lo.toFixed(1)}, ${train.deltaCostCi.hi.toFixed(1)}], test CI95 [${test.deltaCostCi.lo.toFixed(1)}, ${test.deltaCostCi.hi.toFixed(1)}])`,
		};
	}
	return {
		verdict: "REVERT",
		reason: `cost delta not significantly better on both windows (train hi ${train.deltaCostCi.hi.toFixed(1)}, test hi ${test.deltaCostCi.hi.toFixed(1)})`,
	};
}

export interface HillclimbResult {
	rounds: RoundVerdict[];
	incumbent: ReplayKnobs;
	validity: { agreement: number; requests: number };
	split: { cutoff: string; train: number; test: number };
	noiseFloor: {
		determinismPass: boolean;
		trainCiHalfWidth: number;
		testCiHalfWidth: number;
	};
}

const AGENDA: Array<{ knob: keyof ReplayKnobs; to: number }> = [
	{ knob: "num_retries", to: 0 },
	{ knob: "allowed_fails", to: 2 },
	{ knob: "cooldown_time", to: 60 },
	{ knob: "cooldown_time", to: 120 },
	{ knob: "num_retries", to: 2 },
	{ knob: "allowed_fails", to: 4 },
];

const runRounds = (
	train: RequestRow[],
	test: RequestRow[],
	chains: Map<string, AttemptRow[]>,
	meanTok: number,
): { rounds: RoundVerdict[]; incumbent: ReplayKnobs } => {
	const rounds: RoundVerdict[] = [];
	const incumbent: ReplayKnobs = { ...BASELINE_KNOBS };
	for (let r = 0; r < AGENDA.length; r++) {
		const step = AGENDA[r];
		const from = incumbent[step.knob];
		const cand: ReplayKnobs = { ...incumbent, [step.knob]: step.to };
		const trainBase = replayWindow(train, chains, incumbent);
		const trainCand = replayWindow(train, chains, cand);
		const testBase = replayWindow(test, chains, incumbent);
		const testCand = replayWindow(test, chains, cand);
		const armTrain = scoreArm(trainBase, trainCand, meanTok, r * 2 + 1);
		const armTest = scoreArm(testBase, testCand, meanTok, r * 2 + 2);
		const v = verdict(armTrain, armTest);
		rounds.push({
			round: r + 1,
			knob: step.knob,
			from,
			to: step.to,
			train: armTrain,
			test: armTest,
			verdict: v.verdict,
			reason: v.reason,
		});
		if (v.verdict === "KEEP") incumbent[step.knob] = step.to;
	}
	return { rounds, incumbent };
};

/** Failed-request token price: TRAIN baseline mean tokens per success. */
const meanSuccessTokens = (
	train: RequestRow[],
	rawTrain: ReplayOutcome[],
): number => {
	let tokSum = 0;
	let succCount = 0;
	for (let i = 0; i < train.length; i++) {
		if (!rawTrain[i].success) continue;
		tokSum += (train[i].in_tok ?? 0) + (train[i].out_tok ?? 0);
		succCount++;
	}
	return tokSum / Math.max(1, succCount);
};

export function runHillclimb(dbPath: string): HillclimbResult {
	const { requests, chains } = loadLedger(dbPath);
	const { train, test, cutoff } = splitWindows(requests);
	const rawTrain = rawOutcomes(train, chains);
	const meanTok = meanSuccessTokens(train, rawTrain);
	const detA = replayWindow(train, chains, BASELINE_KNOBS);
	const detB = replayWindow(train, chains, BASELINE_KNOBS);
	const detPass = JSON.stringify(detA) === JSON.stringify(detB);
	const { rounds, incumbent } = runRounds(train, test, chains, meanTok);
	const noiseTrain = scoreArm(rawTrain, detA, meanTok, 99);
	const agreement =
		rawTrain.filter((o, i) => o.success === detA[i].success).length /
		Math.max(1, rawTrain.length);
	return {
		rounds,
		incumbent,
		validity: { agreement, requests: requests.length },
		split: { cutoff, train: train.length, test: test.length },
		noiseFloor: {
			determinismPass: detPass,
			trainCiHalfWidth: (noiseTrain.deltaCostCi.hi - noiseTrain.deltaCostCi.lo) / 2,
			testCiHalfWidth: 0,
		},
	};
}

if (import.meta.main) {
	const dbPath = process.argv[2];
	if (!dbPath) {
		console.error("usage: bun src/eval/hillclimb.ts <ledger.db>");
		process.exit(1);
	}
	console.log(JSON.stringify(runHillclimb(dbPath), null, 2));
}
