// packages/blam/bench/paired/types.ts — shared types for the paired-arm
// eval runner (W612). Protocol per docs/harness-lift-research.md lift 5
// (pi-mono packages/evals): every case runs isolated with+without arms
// with repetitions; the report pairs arms per repetition and computes
// lift — the defence against the setup-dependent-gains warning (arXiv
// 2609.05933). Deterministic, LLM-optional: scripted lanes + planes, no
// model calls, no RNG. Spec: bench/paired/scenario.md.

/** One repetition's outcome for one arm — the paired metric schema. */
export interface RepOutcome {
	/** fraction of the case's tasks whose artifact matched ground truth */
	correct: number;
	/** input tokens charged to the lane(s) */
	tokens: number;
	/** wall minutes charged to the lane(s), blocked time included */
	minutes: number;
}

/** A matched pair: the same (case, setup, rep) under both arms. The
 * setup string must be identical across arms — that identity is what
 * neutralizes the setup-dependent-gains confound. */
export interface PairedRep {
	rep: number;
	setup: string;
	on: RepOutcome;
	off: RepOutcome;
}

/** Lift of the on-arm over the off-arm, paired per repetition.
 * Positive token/minute deltas = the on-arm is cheaper/faster. */
export interface Lift {
	reps: number;
	/** mean correct-fraction delta per rep (positive = on-arm fixes tasks) */
	correctDelta: number;
	/** mean token delta per rep (positive = on-arm saves tokens) */
	tokensSaved: number;
	/** mean minute delta per rep (positive = on-arm is faster) */
	minutesSaved: number;
	/** reps where the on-arm saved tokens (sign agreement) */
	tokensSavedReps: number;
	/** reps where the on-arm was faster or equal (sign agreement) */
	minutesSavedReps: number;
	/** reps where the on-arm never lost correctness */
	correctNonNegReps: number;
}

/** Paired lift: deltas are computed WITHIN each rep, then averaged.
 * Ordering by rep index — callers pass pairs in rep order. */
export function pairedLift(pairs: PairedRep[]): Lift {
	const n = pairs.length;
	let correct = 0;
	let tokens = 0;
	let minutes = 0;
	let tokAgree = 0;
	let minAgree = 0;
	let corrAgree = 0;
	for (const p of pairs) {
		const dTok = p.off.tokens - p.on.tokens;
		const dCorr = p.on.correct - p.off.correct;
		correct += dCorr;
		tokens += dTok;
		minutes += p.off.minutes - p.on.minutes;
		if (dTok > 0) tokAgree++;
		if (p.off.minutes - p.on.minutes > 0) minAgree++;
		if (dCorr >= 0) corrAgree++;
	}
	return {
		reps: n,
		correctDelta: n === 0 ? 0 : correct / n,
		tokensSaved: n === 0 ? 0 : tokens / n,
		minutesSaved: n === 0 ? 0 : minutes / n,
		tokensSavedReps: tokAgree,
		minutesSavedReps: minAgree,
		correctNonNegReps: corrAgree,
	};
}
