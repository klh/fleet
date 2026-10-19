// ext-score.ts — scoring for the external known-set slice (W823).
// GAIA-style normalized exact match + WebWalker-style LLM-judge on the
// pinned local tier (:8903, ARENA_JUDGE_PORT/_MODEL — same tier as the W748
// judge pass, format-checked verdicts, injectable for tests). Framing law:
// judge scores are SIGNAL — decisions come from paired A−B deltas with CIs.

// --------------------------------------------------------------- exact match
/** Port of the GAIA eval scorer's normalization: lower, strip punctuation,
 *  drop articles, collapse whitespace; numbers at 2 decimals. */
export function normalizeExt(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\b(a|an|the)\b /g, "")
		.replace(/\s+/g, " ")
		.trim();
}
export function normNumberExt(s: string): number | null {
	const t = s.replace(/[$,%]/g, "").trim();
	const x = Number.parseFloat(t);
	return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}
const PREFIX_RE = /^(\*\*)?(final\s+answer|answer)[.:#*\s]*(\*\*)?\s*/i;
/** Last non-empty line, answer-prefix stripped — the EM-comparable span. */
export function lastAnswerLine(got: string): string {
	const lines = got
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const last = lines.at(-1) ?? "";
	return last.replace(PREFIX_RE, "").trim();
}
export function emCheck(gold: string, got: string): boolean {
	const g = lastAnswerLine(got);
	if (normalizeExt(g) === normalizeExt(gold)) return true;
	const ng = normNumberExt(g);
	const ngold = normNumberExt(gold);
	return ng !== null && ngold !== null && ng === ngold;
}

// -------------------------------------------------------------------- judge
export interface ExtVerdict {
	score: 0 | 1;
	verdict: "correct" | "incorrect";
	reason: string;
}
const strip = (t: string): string =>
	t
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^[\s\S]*<\/think>/, "")
		.trim();
/** Format-checked: score must be 0|1, verdict in vocabulary, consistent. */
export function parseExtVerdict(raw: string): ExtVerdict | null {
	const s = strip(raw);
	const a = s.indexOf("{");
	const b = s.lastIndexOf("}");
	if (a < 0 || b <= a) return null;
	try {
		const j = JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>;
		const sc = j.score;
		const v = String(j.verdict ?? "").toLowerCase();
		if ((sc !== 0 && sc !== 1) || (v !== "correct" && v !== "incorrect"))
			return null;
		if ((sc === 1) !== (v === "correct")) return null;
		return {
			score: sc,
			verdict: v,
			reason: String(j.reason ?? "").slice(0, 240),
		};
	} catch {
		return null;
	}
}
const JUDGE_RUBRIC = `You are a strict QA judge. Decide whether the RESPONSE answers the QUESTION correctly, using the GOLD ANSWER only to verify the same fact, not wording.
Grade the response as a whole; the final answer span decides. Ignore extra verbosity unless it changes the answer.
Reply with ONLY this JSON object, no other text:
{"score": 0|1, "verdict": "correct|incorrect", "reason": "<one sentence>"}`;
/** WebWalker-style graded verdict prompt on question/gold/response. */
export function extJudgePrompt(
	question: string,
	gold: string,
	response: string,
): string {
	return `${JUDGE_RUBRIC}

QUESTION:
"""
${question}
"""

GOLD ANSWER:
"""
${gold}
"""

RESPONSE:
"""
${response.slice(0, 4000)}
"""`;
}

// ------------------------------------------------------------------ scoring
export interface ScoreRow {
	id: string;
	reasoning: string;
	em: boolean | null;
	judge_score: number | null;
	judge_verdict: string;
	judge_reason: string;
	judge_error?: string;
}
export function scoreSlice(
	tasks: ExtTask[],
	answers: Map<string, string>,
): ScoreRow[] {
	return tasks.map((t) => {
		const a = answers.get(t.id);
		if (a === undefined)
			return {
				id: t.id,
				reasoning: t.reasoning,
				em: null,
				judge_score: null,
				judge_verdict: "",
				judge_reason: "",
			};
		return {
			id: t.id,
			reasoning: t.reasoning,
			em: emCheck(t.answer, a),
			judge_score: null,
			judge_verdict: "",
			judge_reason: "",
		};
	});
}

// --------------------------------------------------------------- judge pass
export interface AnswerRow {
	type: "answer" | "judge";
	id: string;
	answer?: string;
	wall_ms?: number;
	error?: string;
	model?: string;
	judge_score?: number | null;
	judge_verdict?: string | null;
	judge_reason?: string;
	judge_error?: string;
}
export interface ExtJudgeOpts {
	file: string;
	tasks: ExtTask[];
	port?: number;
	model?: string;
	limit?: number;
	call?: (p: string) => Promise<string>;
	log?: (s: string) => void;
}
export interface JudgeSummaryExt {
	judged: number;
	resumed: number;
	failed: number;
}
/** File scan: the arm's answers plus already-judged ids (resumable). */
export async function extRows(file: string): Promise<{
	answers: Map<string, string>;
	done: Set<string>;
}> {
	const answers = new Map<string, string>();
	const done = new Set<string>();
	for await (const r of jsonl<AnswerRow>(file)) {
		if (r.type === "answer") {
			if (!r.error && r.answer?.trim()) answers.set(r.id, r.answer);
		} else if (!r.judge_error) done.add(r.id);
	}
	return { answers, done };
}
/** Resumable judge pass over an answers file; verdicts append as judge rows. */
export async function judgeRunExt(o: ExtJudgeOpts): Promise<JudgeSummaryExt> {
	const log = o.log ?? ((s: string) => console.error(s));
	const call =
		o.call ?? ((p: string) => callJudge(p, { port: o.port, model: o.model }));
	try {
		await call("Reply with the single word: ready");
	} catch (e) {
		throw new Error(
			`judge tier preflight failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	const { answers, done } = await extRows(o.file);
	const tasks = new Map(o.tasks.map((t) => [t.id, t]));
	const sum: JudgeSummaryExt = { judged: 0, resumed: 0, failed: 0 };
	const put = (x: AnswerRow) =>
		appendFileSync(o.file, `${JSON.stringify(x)}\n`);
	for (const [id, a] of answers) {
		if (o.limit && sum.judged + sum.resumed >= o.limit) break;
		if (done.has(id)) {
			sum.resumed++;
			continue;
		}
		const t = tasks.get(id);
		if (!t) continue;
		const row: AnswerRow = {
			type: "judge",
			id,
			judge_score: null,
			judge_verdict: null,
			judge_reason: "",
		};
		try {
			const raw = await call(extJudgePrompt(t.prompt, t.answer, a));
			const v = parseExtVerdict(raw);
			if (!v) throw new Error(`unparseable verdict: ${raw.slice(0, 120)}`);
			row.judge_score = v.score;
			row.judge_verdict = v.verdict;
			row.judge_reason = v.reason;
			sum.judged++;
		} catch (e) {
			row.judge_error = String(e instanceof Error ? e.message : e).slice(
				0,
				240,
			);
			sum.failed++;
		}
		put(row);
		log(`judge ${id} score=${row.judge_score ?? "ERR"}`);
	}
	return sum;
}

// ------------------------------------------------------------------- report
export interface ExtGroup {
	group: string;
	k: number;
	n: number;
	ci: [number, number] | null;
}
const groupRecall = (
	rows: ScoreRow[],
	name: string,
	key: "em" | "judge",
	sel: (r: ScoreRow) => boolean = () => true,
): ExtGroup => {
	const xs = rows.filter(sel);
	const hit = (r: ScoreRow) =>
		key === "em" ? r.em === true : r.judge_score === 1;
	const n = xs.filter((r) =>
		key === "em" ? r.em !== null : r.judge_score !== null,
	).length;
	const k = xs.filter(hit).length;
	return { group: name, k, n, ci: wilson(k, n) };
};
const emitGroup = (lines: string[], g: ExtGroup): void => {
	lines.push(
		row([
			g.group,
			`${g.k}/${g.n}`,
			g.n ? `${f2((g.k / g.n) * 100, 1)}%` : "—",
			g.ci ? ci(g.ci, 3) : "—",
			qualLabel(g.n),
		]),
	);
};
/** Markdown recall report: all + per-reasoning groups, both checkers. */
export function extReport(rows: ScoreRow[], label: string): string {
	const lines: string[] = [
		`## external-slice recall — ${label}`,
		"",
		"| group | k/n | recall | 95% CI | n-label |",
		sep(5),
	];
	for (const [name, key] of [
		["em · all", "em"],
		["judge · all", "judge"],
	] as const)
		emitGroup(lines, groupRecall(rows, name, key));
	const types = new Set<string>();
	for (const r of rows)
		for (const t of r.reasoning.split(" | ")) types.add(t.trim());
	for (const t of [...types].sort())
		for (const key of ["em", "judge"] as const) {
			const g = groupRecall(rows, `${key} · ${t}`, key, (r) =>
				r.reasoning
					.split(" | ")
					.map((x) => x.trim())
					.includes(t),
			);
			if (g.n > 0) emitGroup(lines, g);
		}
	const both = rows.filter((r) => r.em !== null && r.judge_score !== null);
	const agree = both.filter((r) => (r.em === true) === (r.judge_score === 1));
	lines.push("", `agreement em∩judge: ${agree.length}/${both.length}`);
	return lines.join("\n");
}
/** Fold judge rows from the answers file back into the scored rows. */
export async function mergeJudge(
	rows: ScoreRow[],
	file: string,
): Promise<ScoreRow[]> {
	const j = new Map<string, AnswerRow>();
	for await (const r of jsonl<AnswerRow>(file))
		if (r.type === "judge") j.set(r.id, r);
	return rows.map((r) => {
		const x = j.get(r.id);
		if (!x) return r;
		return {
			...r,
			judge_score: x.judge_score ?? null,
			judge_verdict: x.judge_verdict ?? "",
			judge_reason: x.judge_reason ?? "",
			judge_error: x.judge_error,
		};
	});
}
import type { ExtTask } from "./ext-seal.ts";
import { callJudge } from "./judge.ts";
import { ci, f2, qualLabel, row, sep, wilson } from "./stats.ts";
import { jsonl } from "./core.ts";
import { appendFileSync } from "node:fs";
