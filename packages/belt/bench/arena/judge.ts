// judge.ts — LLM-as-judge quality pass over an EXISTING arena run (W748,
// lifted from the qvac perf-harness pattern of a separate run-judge pass).
// Rides the :8903 local-reason tier; grades every ok answer in
// results/<run>.jsonl and appends type:"judge" rows back into the run file
// (resumable by cls|task|leg|phase key; rows with judge_error are retried).
// Framing law (benchmarks.md): judge scores are quality SIGNAL — verdicts
// are only ever paired A−B deltas with CIs, never absolute scores.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	CLASSES,
	type ClassId,
	jsonl,
	readCapped,
	RES_DIR,
	stripThink,
} from "./core.ts";
import { buildReq, LEGS, nonceOf } from "./legs.ts";
import type { RawRow } from "./report.ts";
import { loadTasks } from "./seal.ts";

export const JUDGE_PORT = Number(process.env.ARENA_JUDGE_PORT ?? 8903);
export const JUDGE_MODEL = process.env.ARENA_JUDGE_MODEL ?? "default";
export const JUDGE_TIMEOUT_MS = 600e3;

export interface JudgeVerdict {
	score: number;
	verdict: string;
	reason: string;
}
export interface JudgeRowOut {
	type: "judge";
	run: string;
	cls: ClassId;
	task: string;
	leg: string;
	phase: string;
	judge_score: number | null;
	judge_verdict: string | null;
	judge_reason: string;
	judge_model: string;
	judge_wall_ms: number;
	judge_error?: string;
}

/** Head+tail splice keeping both ends of an over-long prompt. */
export function capMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const mark = "\n…[middle elided]…\n";
	const head = Math.floor((max - mark.length) * 0.7);
	const tail = max - mark.length - head;
	return `${s.slice(0, head)}${mark}${s.slice(-tail)}`;
}
export function parseVerdict(raw: string): JudgeVerdict | null {
	const s = stripThink(raw);
	const a = s.indexOf("{");
	const b = s.lastIndexOf("}");
	if (a < 0 || b <= a) return null;
	try {
		const j = JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>;
		const score = typeof j.score === "number" && j.score >= 0 && j.score <= 1 ? j.score : null;
		if (score === null) return null;
		const v = String(j.verdict ?? "").toLowerCase();
		return {
			score,
			verdict: ["good", "mixed", "poor"].includes(v) ? v : "unlabelled",
			reason: String(j.reason ?? "").slice(0, 240),
		};
	} catch {
		return null;
	}
}
/** Minimal openai-wire client — the judge needs the whole body, not a stream. */
export async function callJudge(
	prompt: string,
	o: { port?: number; model?: string; timeoutMs?: number } = {},
): Promise<string> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? JUDGE_TIMEOUT_MS);
	try {
		const res = await fetch(`http://127.0.0.1:${o.port ?? JUDGE_PORT}/v1/chat/completions`, {
			method: "POST",
			signal: ac.signal,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: o.model ?? JUDGE_MODEL,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 512,
				temperature: 0,
				stream: false,
			}),
		});
		const body = await readCapped(res.body, 4 * 1024 * 1024);
		if (!res.ok) throw new Error(`judge ${res.status}: ${body.slice(0, 160)}`);
		const j = JSON.parse(body) as {
			choices?: { message?: { content?: string } }[];
		};
		return String(j.choices?.[0]?.message?.content ?? "");
	} finally {
		clearTimeout(timer);
	}
}
const REF_PRE = /^\[ref:[0-9a-f]+\]\n/;
/** What the model saw, reconstructed from the sealed task (untransformed —
 *  grading against sealed intent is what exposes a transform dropping
 *  constraints), ref nonce stripped. */
export function judgeTaskPrompt(
	run: string,
	cls: ClassId,
	taskId: string,
	legId: string,
	phase: string,
	maxChars: number,
): string {
	const t = loadTasks(cls).tasks.find((x) => x.id === taskId);
	if (!t) throw new Error(`task ${taskId} not in sealed class ${cls}`);
	const leg = LEGS.find((l) => l.id === legId);
	if (!leg) throw new Error(`unknown leg ${legId}`);
	const which: 1 | 2 = phase === "warm" ? 2 : 1;
	const nonce = nonceOf(run, legId, taskId, "cold");
	const seen = buildReq(cls, t, leg, nonce, which).user.replace(REF_PRE, "");
	return capMiddle(seen, maxChars);
}
function rubric(task: string, resp: string): string {
	return `You are a strict quality judge for an LLM benchmark. Grade the RESPONSE against the TASK below.

TASK:
"""
${task}
"""

RESPONSE:
"""
${resp}
"""

Grade: (1) instruction and format compliance, (2) completeness, (3) correctness as far as checkable from the task, (4) no padding, refusal or drift.
score 1.0 fully fulfils the task, 0.5 partial, 0.0 fails or refuses. verdict is "good" (>=0.8), "mixed" (0.4-0.79) or "poor" (<0.4).
Reply with ONLY this JSON object, no other text:
{"score": 0.00, "verdict": "good|mixed|poor", "reason": "<one sentence>"}`;
}
export interface JudgeOpts {
	runId: string;
	resDir?: string;
	port?: number;
	model?: string;
	classes?: ClassId[];
	limit?: number;
	maxPromptChars?: number;
	call?: (prompt: string) => Promise<string>;
	log?: (s: string) => void;
}
export interface JudgeSummary {
	judged: number;
	resumed: number;
	failed: number;
}
export async function judgeRun(o: JudgeOpts): Promise<JudgeSummary> {
	const log = o.log ?? ((s: string) => console.error(s));
	const resDir = o.resDir ?? RES_DIR;
	const file = join(resDir, `${o.runId}.jsonl`);
	if (!existsSync(file)) throw new Error(`missing ${file}`);
	try {
		await callJudge("Reply with the single word: ready", {
			port: o.port,
			model: o.model,
			timeoutMs: 30e3,
		});
	} catch (e) {
		throw new Error(
			`judge tier :${o.port ?? JUDGE_PORT} preflight failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	const classes = o.classes ?? (Object.keys(CLASSES) as ClassId[]);
	const want = new Set(classes);
	const maxChars = o.maxPromptChars ?? 16_000;
	const cands: { r: RawRow }[] = [];
	const done = new Set<string>();
	for await (const x of jsonl<RawRow & { type: string; judge_error?: string }>(file)) {
		if (x.type === "judge") {
			if (!x.judge_error) done.add(`${x.cls}|${x.task}|${x.leg}|${x.phase}`);
		} else if (
			x.type === "row" &&
			x.phase !== "warmup" &&
			x.ok &&
			want.has(x.cls) &&
			!!x.answer?.trim()
		)
			cands.push({ r: x });
	}
	const n0 = Math.max(0, cands.length - done.size);
	log(`judge ${o.runId}: ${cands.length} rows, ${done.size} already judged → ${n0} to go (tier :${o.port ?? JUDGE_PORT})`);
	const call = o.call ?? ((p: string) => callJudge(p, { port: o.port, model: o.model }));
	const counts = new Map<string, number>();
	const put = (x: JudgeRowOut) =>
		appendFileSync(file, `${JSON.stringify(x)}\n`);
	const sum: JudgeSummary = { judged: 0, resumed: 0, failed: 0 };
	for (const { r } of cands) {
		const key = `${r.cls}|${r.task}|${r.leg}|${r.phase}`;
		if (done.has(key)) {
			sum.resumed++;
			continue;
		}
		const lk = `${r.cls}|${r.leg}`;
		if (o.limit) {
			const seen = counts.get(lk) ?? 0;
			if (seen >= o.limit) continue;
			counts.set(lk, seen + 1);
		}
		const row: JudgeRowOut = {
			type: "judge",
			run: o.runId,
			cls: r.cls,
			task: r.task,
			leg: r.leg,
			phase: r.phase,
			judge_score: null,
			judge_verdict: null,
			judge_reason: "",
			judge_model: o.model ?? JUDGE_MODEL,
			judge_wall_ms: 0,
		};
		try {
			const task = judgeTaskPrompt(o.runId, r.cls, r.task, r.leg, r.phase, maxChars);
			const t0 = performance.now();
			const raw = await call(rubric(task, r.answer ?? ""));
			row.judge_wall_ms = Math.round(performance.now() - t0);
			const v = parseVerdict(raw);
			if (!v) throw new Error(`unparseable verdict: ${raw.slice(0, 120)}`);
			row.judge_score = v.score;
			row.judge_verdict = v.verdict;
			row.judge_reason = v.reason;
			sum.judged++;
		} catch (e) {
			row.judge_error = String(e instanceof Error ? e.message : e).slice(0, 240);
			sum.failed++;
		}
		put(row);
		log(`judge ${key} score=${row.judge_score ?? "ERR"} ${row.judge_wall_ms}ms`);
	}
	log(`judge done: ${sum.judged} graded, ${sum.resumed} resumed, ${sum.failed} failed`);
	return sum;
}
