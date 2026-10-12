// packages/blam/bench/paired/harness.ts — the paired-arm runner (W612):
// cases × 2 arms × REPS reps, paired per repetition; the report computes
// lift per case. Deterministic: fixed rep schedules stand in for the
// stochastic world (scenario.md), so repeated runs are byte-identical.
// Run: bun packages/blam/bench/paired/harness.ts
import {
	condenseIntegrityViolations,
	CASE_NAMES,
	resumeIntegrityViolations,
	resumePolicyVerdict,
	runPair,
	steerIntegrityViolations,
	type CaseName,
} from "./cases.ts";
import { type Lift, type PairedRep, pairedLift } from "./types.ts";
import {
	DEFAULT_POLICY_COSTS,
	POLICIES,
	runTask,
} from "../consult/policies.ts";
import {
	DROP_FIRST,
	FRESH,
	matchedSet,
	planeFor,
	runPolicy,
} from "../consult/harness.ts";

/** Repetitions per arm — the pi-mono protocol's rep dimension. Four reps
 * walk the consult matrix and the steer schedule exactly once each. */
export const REPS = 4;

/** Both arms, one case, REPS reps — pairs ordered by rep index. */
export function runCase(name: CaseName): PairedRep[] {
	return Array.from({ length: REPS }, (_, rep) => runPair(name, rep));
}

export interface CaseReport {
	name: CaseName;
	pairs: PairedRep[];
	lift: Lift;
}

/** All cases, with per-case paired lift. */
export function runAll(): CaseReport[] {
	return CASE_NAMES.map((name) => {
		const pairs = runCase(name);
		return { name, pairs, lift: pairedLift(pairs) };
	});
}

// ─── bench properties (reproduction contract, scenario.md) ──────────────
export function checkProperties(): string[] {
	const v: string[] = [];
	// P1 pairing identity: rep indices exact, setups labelled, arms differ
	for (const name of CASE_NAMES) {
		const pairs = runCase(name);
		if (pairs.length !== REPS) v.push(`P1 ${name}: rep count`);
		if (new Set(pairs.map((p) => p.rep)).size !== REPS)
			v.push(`P1 ${name}: rep indices`);
		if (pairs.some((p) => p.setup === "")) v.push(`P1 ${name}: setup label`);
	}
	// P2 condense meaning guard (probe in cases.ts)
	v.push(...condenseIntegrityViolations().map((s) => `P2 ${s}`));
	// P3 no false consults: the control task draws zero asks under BOTH arms
	const nc = matchedSet(FRESH.codeVersion).find(
		(t) => t.profile === "no-consult-control",
	);
	if (nc === undefined) {
		v.push("P3 control task missing");
	} else {
		for (const arm of ["current-instructions", "trigger"] as const) {
			const r = runTask(
				{ plane: planeFor(FRESH), task: nc, costs: DEFAULT_POLICY_COSTS },
				POLICIES[arm],
			);
			if (r.metrics.attemptedCalls !== 0)
				v.push(`P3 ${arm} consulted the control task`);
		}
	}
	// P4 steer drain bound (probe in cases.ts)
	v.push(...steerIntegrityViolations().map((s) => `P4 ${s}`));
	// P5 injected delivery drops are counted on the drop plane
	const df = runPolicy("trigger", DROP_FIRST).total.deliveryFailures;
	if (df < 1) v.push("P5 delivery drops not counted");
	// P6 resume freshness gate is structural (probe in cases.ts)
	v.push(...resumeIntegrityViolations().map((s) => `P6 ${s}`));
	return v;
}

// ─── report ──────────────────────────────────────────────────────────────
function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Per-arm means over reps, then the paired-lift line. */
export function formatReport(): string {
	const reports = runAll();
	const lines: string[] = [];
	lines.push(
		`W612 paired-arm evals — ${reports.length} cases × 2 arms × ${REPS} reps, paired per rep`,
	);
	lines.push(
		`${pad("case/arm", 24)}${pad("ok", 7)}${pad("tok/rep", 9)}${pad("min/rep", 8)}`,
	);
	for (const r of reports) {
		const mean = (f: (p: PairedRep) => number) =>
			r.pairs.reduce((a, p) => a + f(p), 0) / r.pairs.length;
		for (const arm of ["on", "off"] as const) {
			lines.push(
				pad(`${r.name} ${arm}`, 24) +
					pad(mean((p) => p[arm].correct).toFixed(2), 7) +
					pad(String(Math.round(mean((p) => p[arm].tokens))), 9) +
					pad(mean((p) => p[arm].minutes).toFixed(1), 8),
			);
		}
		const l = r.lift;
		lines.push(
			`  lift: ok ${l.correctDelta >= 0 ? "+" : ""}${l.correctDelta.toFixed(2)}/rep` +
				` · tok saved ${Math.round(l.tokensSaved)}/rep (${l.tokensSavedReps}/${l.reps} reps)` +
				` · min saved ${l.minutesSaved.toFixed(1)}/rep (${l.minutesSavedReps}/${l.reps} reps)`,
		);
	}
	// W622: the retake knob verdict falls out of the measured lift —
	// pre-registered rule, not prose.
	const verdict = resumePolicyVerdict();
	for (const [id, v] of Object.entries(verdict)) {
		lines.push(
			`  knob ${id}: ${v.knob ? "RESUME" : "FRESH"} (lift ${v.lift.correctDelta >= 0 ? "+" : ""}${v.lift.correctDelta.toFixed(2)} ok, ${Math.round(v.lift.tokensSaved)} tok, ${v.lift.minutesSaved.toFixed(1)} min per rep)`,
		);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const violations = checkProperties();
	if (violations.length > 0) {
		console.error(violations.map((s) => `✗ ${s}`).join("\n"));
		process.exit(1);
	}
	console.log(formatReport());
	console.log(`\n6/6 properties hold (bench/paired/scenario.md)`);
}
