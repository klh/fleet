// review-core.ts — W792: types, constants and the line-diff util for the
// review A/B arena (arm A = single-pass oracle review, arm B = the
// how-to-review.md pipeline). Zero dependencies beyond arena core/stats/legs.
import { sha } from "./core.ts";

export const REVIEW_DIR = "review-seal"; // sealed task dir under bench/arena/
export const REVIEW_SEED = "review-arena/2026-10-18";
export const LINE_TOL = 5; // finding matches a defect within ±5 lines

// ---------------------------------------------------------------- defect classes
export const DEFECT_CLASSES = [
	"off-by-one",
	"inverted-condition",
	"dropped-await",
	"swapped-args",
	"boundary",
	"wrong-var",
	"null-deref",
	"wrong-constant",
	"dropped-check",
	"resource-leak",
	"n-plus-one",
	"argv-misparse",
	"privileged-bind",
] as const;
export type DefectClass = (typeof DEFECT_CLASSES)[number];

export interface Defect {
	id: string;
	cls: DefectClass;
	file: string;
	line: number; // 1-based, in the buggy (reviewed) file version
	desc: string;
}

export type TaskSrc = "seeded" | "incident" | "clean";

export interface ReviewTask {
	id: string;
	src: TaskSrc;
	title: string;
	mission: string; // the stated intent a reviewer checks the diff against
	diff: string; // unified diff, fixed → buggy (the + lines carry the defect)
	defects: Defect[]; // empty for clean tasks
	/** Full buggy/fixed file content for the defected file(s) — the arm-B
	 *  fixer leg edits the real file, rounds re-diff against `fixed`. */
	files?: { buggy: Record<string, string>; fixed: Record<string, string> };
}

// ---------------------------------------------------------------- findings
export type Severity = "high" | "medium" | "low";
export interface Finding {
	severity: Severity;
	file: string;
	line: number;
	issue: string;
}

export const REVIEW_VERBS = ["hunter", "reviewer", "verifier", "fixer"] as const;
export type ReviewVerb = (typeof REVIEW_VERBS)[number];

// ---------------------------------------------------------------- legs (config-over-code)
const envPort = (name: string, dflt: number): number => {
	const v = process.env[name];
	const n = v ? Number(v) : NaN;
	return Number.isFinite(n) && n > 0 ? n : dflt;
};
/** Canonical tier placement for each pipeline leg. :8901 coder and :8912 kev
 *  are the canon; when a tier is down the run refuses fast unless the env
 *  re-points the leg (recorded per row, reported honestly). */
export const REVIEW_LEGS = {
	hunter: { port: envPort("REVIEW_HUNTER_PORT", 8903), tier: "reason" },
	reviewer: { port: envPort("REVIEW_REVIEWER_PORT", 8903), tier: "reason" },
	verifier: { port: envPort("REVIEW_VERIFIER_PORT", 8903), tier: "reason" },
	fixer: { port: envPort("REVIEW_FIXER_PORT", 8901), tier: "coder" },
	/** v1 deviation: :8912 kev speaks its SystemOne wire (state+questions),
	 *  not the openai chat wire the arena legs share — the kev ROLE (severity/
	 *  class triage) rides the extract tier; REVIEW_TRIAGE_PORT re-points. */
	triage: { port: envPort("REVIEW_TRIAGE_PORT", 8902), tier: "extract (kev-role)" },
} as const;
export type LegName = keyof typeof REVIEW_LEGS;

export const ARM_A_PORT = envPort("REVIEW_ARM_A_PORT", 8903);
export const MAX_ROUNDS = 3;
export const CALL_TIMEOUT_MS = 300e3;
export const MAX_TOKENS = 1500; // oracle.ts default — arm parity

// ---------------------------------------------------------------- unified diff
type Line = string;
/** Classic LCS table over lines — files here are ≤ a few hundred lines. */
function lcsTable(a: Line[], b: Line[]): Uint32Array {
	const w = b.length + 1;
	const t = new Uint32Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			t[i * w + j] =
				a[i] === b[j]
					? (t[(i + 1) * w + j + 1] ?? 0) + 1
					: Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
		}
	}
	return t;
}
/** Unified diff of aLines → bLines with git-style @@ headers (no index line). */
export function unifiedDiff(
	path: string,
	aLines: Line[],
	bLines: Line[],
	context = 3,
): string {
	const t = lcsTable(aLines, bLines);
	const w = bLines.length + 1;
	const ops: { kind: "same" | "del" | "add"; a?: number; b?: number; text: Line }[] =
		[];
	let i = 0;
	let j = 0;
	while (i < aLines.length && j < bLines.length) {
		if (aLines[i] === bLines[j]) {
			ops.push({ kind: "same", a: i, b: j, text: aLines[i] ?? "" });
			i++;
			j++;
		} else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) {
			ops.push({ kind: "del", a: i, text: aLines[i] ?? "" });
			i++;
		} else {
			ops.push({ kind: "add", b: j, text: bLines[j] ?? "" });
			j++;
		}
	}
	while (i < aLines.length) {
		ops.push({ kind: "del", a: i, text: aLines[i] ?? "" });
		i++;
	}
	while (j < bLines.length) {
		ops.push({ kind: "add", b: j, text: bLines[j] ?? "" });
		j++;
	}
	// group change runs into hunks: a new hunk when > context same-lines of
	// gap (2*context+1 ops) after the previous change
	const changes: number[] = [];
	ops.forEach((op, k) => {
		if (op.kind !== "same") changes.push(k);
	});
	if (changes.length === 0) return "";
	const hunks: [number, number][] = [];
	let g0 = changes[0] ?? 0;
	let gLast = g0;
	for (const k of changes.slice(1)) {
		if (k - gLast > context * 2 + 1) {
			hunks.push([g0, gLast]);
			g0 = k;
		}
		gLast = k;
	}
	hunks.push([g0, gLast]);
	const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
	for (let h = 0; h < hunks.length; h++) {
		const [c0, c1] = hunks[h] ?? [0, 0];
		const start = Math.max(0, c0 - context); // leading context, ≤ 3 lines
		const end = Math.min(ops.length, c1 + 1 + context);
		let a0 = -1;
		let b0 = -1;
		let ac = 0;
		let bc = 0;
		const body: string[] = [];
		for (let k = start; k < end; k++) {
			const op = ops[k] ?? { kind: "same" as const, text: "" };
			const line = op.text;
			if (op.kind === "same") {
				if (a0 < 0) {
					a0 = (op.a ?? 0) + 1;
					b0 = (op.b ?? 0) + 1;
				}
				ac++;
				bc++;
				body.push(` ${line}`);
			} else if (op.kind === "del") {
				if (a0 < 0) {
					a0 = (op.a ?? 0) + 1;
					b0 = (op.b ?? 0) + 1;
				}
				ac++;
				body.push(`-${line}`);
			} else {
				if (a0 < 0) {
					a0 = (op.a ?? 0) + 1;
					b0 = (op.b ?? 0) + 1;
				}
				bc++;
				body.push(`+${line}`);
			}
		}
		out.push(`@@ -${Math.max(1, a0)},${ac} +${Math.max(1, b0)},${bc} @@`);
		out.push(...body);
	}
	return `${out.join("\n")}\n`;
}

/** 1-based line of the first occurrence of `anchor` in `content` (0 → absent). */
export function lineOf(content: string, anchor: string): number {
	const idx = content.indexOf(anchor);
	if (idx < 0) return 0;
	return content.slice(0, idx).split("\n").length;
}

export const reviewTaskSha = (t: ReviewTask): string =>
	sha(`${t.id}|${t.diff}`).slice(0, 16);
