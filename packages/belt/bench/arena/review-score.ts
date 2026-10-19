// review-score.ts — W792: match findings against seeded ground truth and
// aggregate the A/B metrics: recall on seeded bugs, false positives on clean
// files, rounds-to-pass, token cost per review (W776 attribution) and the
// human-required findings count.
import { basename } from "node:path";
import type { Defect, Finding } from "./review-core.ts";
import { LINE_TOL } from "./review-core.ts";
import { median } from "./stats.ts";

export interface FindingMatch {
	finding: Finding;
	matchedDefect: string | null; // defect id or null
	sameFileWrongLine: boolean; // cited the right file, outside line tolerance
}

const norm = (f: string): string => basename(f).replace(/\.test\.ts$/, ".ts");

/** Mechanical matcher: same file basename + line within ±LINE_TOL. */
export function matchFindings(
	defects: Defect[],
	findings: Finding[],
): {
	matches: FindingMatch[];
	recall: number; // matched defects / total defects
	fileRecall: number; // defects whose FILE was cited at any line
	defectHits: Set<string>;
} {
	const defectHits = new Set<string>();
	const fileHits = new Set<string>();
	const matches: FindingMatch[] = findings.map((f) => {
		const hit = defects.find(
			(d) =>
				norm(f.file) === norm(d.file) && Math.abs(f.line - d.line) <= LINE_TOL,
		);
		if (hit) defectHits.add(hit.id);
		const fileOnly = defects.find((d) => norm(f.file) === norm(d.file));
		if (fileOnly) fileHits.add(fileOnly.id);
		return {
			finding: f,
			matchedDefect: hit?.id ?? null,
			sameFileWrongLine: !hit && !!fileOnly,
		};
	});
	return {
		matches,
		recall: defects.length ? defectHits.size / defects.length : 1,
		fileRecall: defects.length ? fileHits.size / defects.length : 1,
		defectHits,
	};
}

export interface ArmOutcome {
	arm: "a" | "b";
	taskId: string;
	src: string;
	/** unique final findings (posted set, after dedupe across rounds) */
	findings: Finding[];
	recall: number;
	fileRecall: number;
	/** findings citing files with no seeded defect (clean-file noise) */
	fp: number;
	/** Important-severity findings a human must read */
	humanRequired: number;
	/** Important findings on clean files (pure human cost) — clean tasks only */
	humanNoise: number;
	roundsToPass: number; // 1..3 = converged round; 4 = never within cap
	/** W832: prior blocker IDs left open at the final verdict (still-open,
	 *  not-verifiable or never acknowledged) — a PASS over these is wrong. */
	openBlockers: string[];
	verdictCorrect: boolean; // final verdict matches seeded truth
	tokIn: number;
	tokOut: number;
	calls: number;
	wallMs: number;
	verdict: "PASS" | "FAIL";
}

export interface ArmAggregate {
	arm: "a" | "b";
	n: number;
	recall: number; // pooled: matched defects / total defects
	fileRecall: number;
	meanFpPerTask: number;
	humanRequiredPerTask: number;
	humanNoisePerCleanTask: number;
	converged: number; // roundsToPass ≤ 3
	medianRounds: number | null;
	verdictAccuracy: number;
	tokInP50: number | null;
	tokOutP50: number | null;
	callsP50: number | null;
	wallP50: number | null;
}

/** Score one task-arm outcome against its ground truth. */
export function scoreOutcome(o: {
	arm: "a" | "b";
	taskId: string;
	src: string;
	defects: Defect[];
	findings: Finding[];
	roundsToPass: number;
	verdict: "PASS" | "FAIL";
	/** W832: prior blocker IDs still open at the final verdict. */
	openBlockers?: string[];
	tokIn: number;
	tokOut: number;
	calls: number;
	wallMs: number;
}): ArmOutcome {
	const { matches, recall, fileRecall } = matchFindings(o.defects, o.findings);
	const defectFiles = new Set(o.defects.map((d) => d.file));
	const truthHasDefects = o.defects.length > 0;
	const fp = matches.filter(
		(m) => !m.matchedDefect && !defectFiles.has(m.finding.file),
	).length;
	const important = matches.filter((m) => m.finding.severity === "high");
	const humanRequired = important.length;
	// clean task: every finding is human noise (nothing seeded to find)
	const humanNoise = truthHasDefects ? 0 : matches.length;
	const openBlockers = o.openBlockers ?? [];
	// outcome-correct verdict: on defect tasks, FAIL is correct AND so is a
	// PASS reached after a recall>0 fix (found-and-fixed is the pipeline's
	// success path); the only wrong verdicts are PASS with zero detection and
	// — W832 — PASS over an open prior blocker (only explicit fixed closes).
	const verdictCorrect = truthHasDefects
		? o.verdict === "FAIL" ||
			(o.verdict === "PASS" && recall > 0 && openBlockers.length === 0)
		: o.verdict === "PASS" && openBlockers.length === 0;
	return {
		arm: o.arm,
		taskId: o.taskId,
		src: o.src,
		findings: o.findings,
		recall,
		fileRecall,
		fp,
		humanRequired,
		humanNoise,
		roundsToPass: o.roundsToPass,
		openBlockers,
		verdictCorrect,
		tokIn: o.tokIn,
		tokOut: o.tokOut,
		calls: o.calls,
		wallMs: o.wallMs,
		verdict: o.verdict,
	};
}

/** Aggregate outcomes for one arm. */
export function aggregate(arm: "a" | "b", outs: ArmOutcome[]): ArmAggregate {
	const seeded = outs.filter((o) => o.src !== "clean");
	const clean = outs.filter((o) => o.src === "clean");
	const recall =
		seeded.length === 0
			? 0
			: seeded.reduce((a, o) => a + o.recall, 0) / seeded.length;
	return {
		arm,
		n: outs.length,
		recall,
		fileRecall:
			seeded.length === 0
				? 0
				: seeded.reduce((a, o) => a + o.fileRecall, 0) / seeded.length,
		meanFpPerTask: outs.length
			? outs.reduce((a, o) => a + o.fp, 0) / outs.length
			: 0,
		humanRequiredPerTask: outs.length
			? outs.reduce((a, o) => a + o.humanRequired, 0) / outs.length
			: 0,
		humanNoisePerCleanTask: clean.length
			? clean.reduce((a, o) => a + o.humanNoise, 0) / clean.length
			: 0,
		converged: outs.filter((o) => o.roundsToPass <= 3).length,
		medianRounds: median(outs.map((o) => o.roundsToPass)),
		verdictAccuracy: outs.length
			? outs.filter((o) => o.verdictCorrect).length / outs.length
			: 0,
		tokInP50: median(outs.map((o) => o.tokIn)),
		tokOutP50: median(outs.map((o) => o.tokOut)),
		callsP50: median(outs.map((o) => o.calls)),
		wallP50: median(outs.map((o) => o.wallMs)),
	};
}
