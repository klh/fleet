// packages/blam/bench/crash/harness.ts — the S1-S5 matrix runner (W840):
// five scenarios × pre/post planes × RUNS reps, fresh git fixture per run.
// Determinism: repeated matrices byte-identical. A/B contract: post-fix
// passes every property on every run; pre-fix reproduces the 2026-09-28
// headline (S1/S4/S5 fail). Spec: bench/crash/scenario.md.
// Run: bun packages/blam/bench/crash/harness.ts
import { type Era, type RunOutcome, SCENARIO_IDS, type ScenarioId } from "./types.ts";
import { s1, s2, s3, s4, s5 } from "./scenarios.ts";

/** Repetitions per cell — the ≥9/10 reproducibility bar (README). */
export const RUNS = 10;

const DRIVERS: Record<ScenarioId, (era: Era, run: number) => RunOutcome> = {
	S1: s1,
	S2: s2,
	S3: s3,
	S4: s4,
	S5: s5,
};

/** One deterministic run of one scenario on one plane. */
export function runScenario(id: ScenarioId, era: Era, runs: number): RunOutcome {
	return DRIVERS[id](era, runs);
}

/** The full matrix: 5 scenarios × 2 planes × RUNS reps. */
export function runMatrix(): RunOutcome[] {
	const out: RunOutcome[] = [];
	for (const id of SCENARIO_IDS) {
		for (const era of ["pre", "post"] as const) {
			for (let run = 1; run <= RUNS; run++) {
				out.push(DRIVERS[id](era, run));
			}
		}
	}
	return out;
}

/** Compact A/B report: per scenario×plane cell (all reps identical). */
export function formatReport(outcomes: RunOutcome[]): string {
	const lines = ["scn   era   props  ttd  ttr  fbr  dl  determinism"];
	for (const id of SCENARIO_IDS) {
		for (const era of ["pre", "post"] as const) {
			const cell = outcomes.filter((o) => o.scenario === id && o.era === era);
			const r1 = cell[0];
			const props = Object.entries(r1.properties);
			const ok = props.filter(([, h]) => h).length;
			const stripRun = (o: RunOutcome) => {
				const { run: _r, ...rest } = o;
				return rest;
			};
			const same = cell.every((o) => JSON.stringify(stripRun(o)) === JSON.stringify(stripRun(r1)));
			const t = (v: number | null) => (v === null ? "—" : String(v));
			lines.push(
				`${id.padEnd(4)}  ${era.padEnd(4)}  ${ok}/${props.length}     ` +
					`${t(r1.ttdTicks)}    ${t(r1.ttrTicks)}    ` +
					`${r1.falseBlocks}    ${r1.dataLoss}   ${same ? "10/10" : "DRIFT"}`,
			);
		}
	}
	return lines.join("\n");
}

/** Harness contract: post-fix all-pass with detection, pre-fix headline
 * (S1/S4/S5) reproduced, repeated matrices byte-identical. */
export function checkMatrix(outcomes: RunOutcome[]): string[] {
	const v: string[] = [];
	for (const o of outcomes.filter((o) => o.era === "post")) {
		for (const [name, held] of Object.entries(o.properties)) {
			if (!held) v.push(`${o.scenario} r${o.run}: post ${name}`);
		}
		if (o.ttdTicks === null) v.push(`${o.scenario} r${o.run}: post no detection`);
	}
	const pre = outcomes.filter((o) => o.era === "pre" && o.run === 1);
	const headline: Array<[ScenarioId, string]> = [
		["S1", "no-false-retire"],
		["S4", "next-not-falsely-failed"],
		["S4", "no-data-loss"],
		["S5", "no-foreign-conclusion"],
	];
	for (const [id, prop] of headline) {
		const o = pre.find((p) => p.scenario === id);
		if (o && o.properties[prop] !== false) {
			v.push(`${id}: pre-fix headline not reproduced (${prop})`);
		}
	}
	const again = runMatrix();
	if (JSON.stringify(again) !== JSON.stringify(outcomes)) {
		v.push("determinism: repeated matrices differ");
	}
	return v;
}

if (import.meta.main) {
	const outcomes = runMatrix();
	const v = checkMatrix(outcomes);
	if (v.length > 0) {
		console.error(v.map((s) => `✗ ${s}`).join("\n"));
		process.exit(1);
	}
	console.log(formatReport(outcomes));
	console.log(
		"\nA/B contract holds: post-fix 5/5 all properties; " +
			"pre-fix reproduces S1/S4/S5; matrices byte-identical.",
	);
}
