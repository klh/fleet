// bench/artifact/types.ts — W2904 artifact-bench types + the decision-grade
// kernel. Arms are ARTIFACT refs (image@digest, package version, toolchain
// pin), not behaviors. Every scenario declares a DecisionRule up front; a
// run without a rule cannot emit a receipt (decision-grade law: rows exist
// to pick a winner, or to declare an explicit tie — never to "just measure").
// Parity law: samples are only comparable inside one caps block.

/** kind of artifact an arm pins. digest pins are preferred; loose tags are
 * recorded as-is and flagged in the receipt (`pinned: false`). */
export type ArtifactKind = "image" | "package" | "toolchain";

export interface ArmRef {
	kind: ArtifactKind;
	/** artifact identity, e.g. "alpine:3.21@sha256:..." or "bun@1.4.4". */
	id: string;
	label: string;
	/** true when id carries a digest or exact version (not a moving tag). */
	pinned: boolean;
}

/** machine block a receipt is invalid without — the parity witness. */
export interface Caps {
	bed: string; // docker-desktop | colima-zram | azure | ...
	host: string;
	kernel: string;
	arch: string;
	cpu: number;
	memMiB: number;
}

export interface ScenarioSpec {
	id: string;
	title: string;
	/** what a winner MEANS here, one line. Shown in receipts and ledgers. */
	decision: string;
	rule: DecisionRule;
	arms: ArmRef[];
	reps: number;
	seed: number;
}

/** declarative decision rule — the only sanctioned way to emit a verdict. */
export interface DecisionRule {
	/** statistic compared across arms. */
	stat: "median" | "p95";
	/** true = smaller wins (latency-like); false = larger wins. */
	lowerWins: boolean;
	/** relative band around the best stat inside which arms count as tied
	 * (0.05 = within 5% of the best → tied). Winnerless rows are impossible
	 * by construction: outside the band a winner is named, inside it the
	 * verdict is the explicit `tied`. */
	tieEpsilon: number;
}

export interface ArmSamples {
	arm: string; // ArmRef.id
	/** one measured value per completed rep (ms, or the scenario's unit). */
	samples: number[];
}

export type Stat = { median: number; p95: number };

/** verdict is REQUIRED on every summary — this is the decision-grade law
 * as a type: `winner` names an arm id, or the literal tied. */
export type Verdict = {
	winner: string | "tied";
	rule: DecisionRule;
	/** winner's stat value; null on tied (all inside the band). */
	best: number | null;
	/** margin of the winner over the runner-up, relative to runner-up; null
	 * on tied. Negative margins cannot occur (winner is the best). */
	marginRel: number | null;
	tiedArms: string[];
};

export function statOf(samples: number[], stat: DecisionRule["stat"]): number {
	if (samples.length === 0) throw new Error("no samples");
	const s = [...samples].sort((a, b) => a - b);
	if (stat === "median") {
		const mid = s.length >> 1;
		return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
	}
	const idx = Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1);
	return s[idx]!;
}

/** the decision-grade kernel: pure, total, tie-explicit. */
export function computeVerdict(arms: ArmSamples[], rule: DecisionRule): Verdict {
	const stats = new Map<string, number>();
	for (const a of arms) stats.set(a.arm, statOf(a.samples, rule.stat));
	const ranked = [...stats.entries()].sort((x, y) =>
		rule.lowerWins ? x[1] - y[1] : y[1] - x[1],
	);
	const best = ranked[0]!;
	const band = Math.abs(best[1]) * rule.tieEpsilon;
	const tiedArms = ranked.filter(([, v]) => Math.abs(v - best[1]) <= band).map(([k]) => k);
	if (tiedArms.length > 1) {
		return { winner: "tied", rule, best: null, marginRel: null, tiedArms };
	}
	const runnerUp = ranked[1];
	const marginRel = runnerUp
		? Math.abs(runnerUp[1] - best[1]) / Math.abs(runnerUp[1])
		: Number.POSITIVE_INFINITY; // single-arm scenarios decide trivially
	return { winner: best[0], rule, best: best[1], marginRel, tiedArms: [best[0]] };
}

/** seeded PRNG (mulberry32) — the controlled-ordering witness. Same seed,
 * same walk order, byte-identical receipts. */
export function seededOrder(n: number, seed: number): number[] {
	let a = seed >>> 0;
	const rand = () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const idx = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[idx[i], idx[j]] = [idx[j]!, idx[i]!];
	}
	return idx;
}
