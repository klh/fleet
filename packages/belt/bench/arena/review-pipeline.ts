// review-pipeline.ts — W792: the two arms of the review A/B.
// Arm A = the current single-pass oracle review (the exact oracle.ts frame,
// pinned :8903 leg). Arm B = the how-to-review.md pipeline: checklist
// reviewer → per-finding verifier → triage → fixer rounds (cap 3),
// re-reviewing only the new diff each round.
import {
	CALL_TIMEOUT_MS,
	type Finding,
	lineOf,
	MAX_ROUNDS,
	MAX_TOKENS,
	type ReviewTask,
	REVIEW_LEGS,
	ARM_A_PORT,
	unifiedDiff,
} from "./review-core.ts";
import { callLeg } from "./legs.ts";
import type { Leg, Req } from "./legs.ts";
import { stripThink } from "./core.ts";
import {
	parseFindings,
	parseFix,
	parseTriage,
	parseVerdictLine,
	parseVerify,
} from "./review-parse.ts";

// the EXACT oracle.ts review frame — arm parity with the live practice
const ORACLE_REVIEW_FRAME = [
	"You are a read-only reviewer (oracle fixed contract). Review this diff.",
	"Audit, never re-do. Findings as terse bullets — severity(high|medium|low): file:line — issue. No style nits.",
	"End your reply with ONE machine-parseable final line:",
	"VERDICT: PASS | VERDICT: FAIL - <reason>",
].join("\n");
const DIFF_CAP = 60_000; // oracle.ts INPUT_CAP — arm parity

// the arm-B reviewer brief: the how-to-review.md reviewer checklist + the
// package REVIEW.md analog (what failure looks like in belt/suspenders code,
// capped nits, evidence = file:line). This IS the pipeline's review profile.
const BENCH_REVIEW_CONTRACT = [
	"You are a fresh-context code reviewer. Review the DIFF below against the MISSION.",
	"Findings as terse bullets — severity(high|medium|low): file:line — issue. No style nits.",
].join("\n");

// treatment suffix: the how-to-review.md checklist rides AFTER the diff —
// the local reviewer leg complies with the machine format only when the
// contract sits up top and the checklist trails the diff (recency).
const BENCH_REVIEW_SUFFIX = [
	"Reviewer checklist (how-to-review.md): Intent — does it do what the mission says, only that, nothing hidden? Evidence — what verification exists, what would the checks miss? Blast radius — what imports this, what breaks downstream?",
	"Hunt list (agent-produced code): contract drift, store-RPC storms, dropped guards, constant/schema drift. Cap style nits at zero unless they mask a real defect. Flag the CLASS, not one instance.",
	"End with ONE machine-parseable final line: VERDICT: PASS | VERDICT: FAIL - <reason>",
].join("\n");

const VERIFIER_FRAME = [
	"You are a read-only verification pass for a bug-hunt (how-to-review.md: LLM output is leads, not facts).",
	"For each numbered finding below, answer whether the DIFF actually shows it.",
	"Reply ONE line per finding, in order, exactly:",
	"N: confirmed | refuted | unclear",
].join("\n");

const TRIAGE_FRAME = [
	"You are a read-only triage pass (how-to-review.md classifier role).",
	"Tag each numbered finding: important (a defect the change introduces),",
	"nit (style/diagnostic only), or pre-existing (bug the change didn't introduce).",
	"Reply ONE line per finding, in order, exactly:",
	"N: important | nit | pre-existing",
].join("\n");

const FIXER_FRAME = [
	"You are a repair pass. You get one source file and the confirmed findings.",
	"Return the CORRECTED FULL FILE in one fenced block. No commentary.",
	"Fix every finding's root cause; keep style and contracts intact.",
].join("\n");

export interface TraceRow {
	type: "call";
	leg: string;
	round: number;
	port: number;
	ok: boolean;
	ms: number;
	inTok: number;
	outTok: number;
	err?: string;
}
export interface ArmRun {
	arm: "a" | "b";
	findings: Finding[];
	verdict: "PASS" | "FAIL";
	roundsToPass: number;
	tokIn: number;
	tokOut: number;
	calls: number;
	wallMs: number;
	trace: TraceRow[];
	ok: boolean;
	err?: string;
}
const acc0 = (): { tokIn: number; tokOut: number; calls: number; wallMs: number; trace: TraceRow[] } => ({
	tokIn: 0,
	tokOut: 0,
	calls: 0,
	wallMs: 0,
	trace: [],
});

async function callLocal(
	acc: ReturnType<typeof acc0>,
	prompt: string,
	port: number,
	legName: string,
	round = 0,
): Promise<{ ok: boolean; text: string; err?: string }> {
	const leg: Leg = { id: "local-direct", wire: "openai", priced: "local", desc: "review arena" };
	const q: Req = {
		user: prompt,
		maxTokens: MAX_TOKENS,
		effort: null,
		timeoutMs: CALL_TIMEOUT_MS,
		port,
	};
	const t0 = performance.now();
	const o = await callLeg(leg, q);
	acc.tokIn += o.inTok;
	acc.tokOut += o.outTok;
	acc.calls++;
	acc.wallMs += Math.round(o.wall);
	acc.trace.push({
		type: "call",
		leg: legName,
		round,
		port,
		ok: o.ok,
		ms: Math.round(o.wall),
		inTok: o.inTok,
		outTok: o.outTok,
		err: o.err,
	});
	return { ok: o.ok, text: stripThink(o.text), err: o.err };
}

const diffFor = (t: ReviewTask): string => t.diff.slice(0, DIFF_CAP);
const findKey = (f: Finding): string => `${f.file}:${f.line}:${f.issue.slice(0, 40)}`;

/** Arm A — the current single-pass oracle review. One call, no rounds. */
export async function armA(task: ReviewTask, port = ARM_A_PORT): Promise<ArmRun> {
	const acc = acc0();
	const res = await callLocal(
		acc,
		`${ORACLE_REVIEW_FRAME}\n\nDIFF:\n${diffFor(task)}`,
		port,
		"armA-review",
		1,
	);
	const findings = res.ok ? parseFindings(res.text) : [];
	const v = res.ok ? parseVerdictLine(res.text) : null;
	return {
		arm: "a",
		findings,
		verdict: v?.verdict ?? "FAIL",
		roundsToPass: v?.verdict === "PASS" ? 1 : MAX_ROUNDS + 1,
		...acc,
		ok: res.ok,
		err: res.err,
	};
}

/** Arm B — the how-to-review.md pipeline on one task. */
export async function armB(task: ReviewTask): Promise<ArmRun> {
	const acc = acc0();
	const posted: Finding[] = [];
	const postedKeys = new Set<string>();
	let curDiff = task.diff;
	let rounds = MAX_ROUNDS + 1;
	let verdict: "PASS" | "FAIL" = "FAIL";
	for (let round = 1; round <= MAX_ROUNDS; round++) {
		const postedBlock = postedKeys.size
			? `ALREADY POSTED (never repeat; report only NEW findings):\n${[...postedKeys].map((k) => `- ${k}`).join("\n")}\n\n`
			: "";
		const prompt = `${BENCH_REVIEW_CONTRACT}\n\nMISSION: ${task.mission}\n\n${postedBlock}DIFF:\n${curDiff}\n\n${BENCH_REVIEW_SUFFIX}`;
		// the local reviewer leg format-flakes at temp 0 (server-side sampling
		// nondeterminism) — re-ask until parseable, max 3 attempts; every
		// attempt is token-attributed through acc
		let rev = await callLocal(acc, prompt, REVIEW_LEGS.reviewer.port, "reviewer", round);
		let attempts = 1;
		while (
			rev.ok &&
			rev.text.length > 0 &&
			parseFindings(rev.text).length === 0 &&
			parseVerdictLine(rev.text).verdict === "FAIL" &&
			attempts < 3
		) {
			rev = await callLocal(acc, prompt, REVIEW_LEGS.reviewer.port, "reviewer", round);
			attempts++;
		}
		if (!rev.ok)
			return { arm: "b", findings: posted, verdict: "FAIL", roundsToPass: MAX_ROUNDS + 1, ...acc, ok: false, err: rev.err };
		const rf = parseFindings(rev.text);
		// format-miss guard: a FAIL verdict with zero parseable findings is an
		// honest FAIL (never auto-PASS through the convergence gate)
		const rv = parseVerdictLine(rev.text);
		if (rf.length === 0 && rv.verdict === "FAIL")
			return {
				arm: "b",
				findings: posted,
				verdict: "FAIL",
				roundsToPass: MAX_ROUNDS + 1,
				...acc,
				ok: true,
				err: "reviewer FAILed with 0 parseable findings",
			};
		let confirmed = rf;

		if (rf.length) {
			const vRes = await callLocal(
				acc,
				`${VERIFIER_FRAME}\n\nDIFF:\n${curDiff}\n\nFINDINGS:\n${rf
					.map((f, i) => `${i + 1}. ${f.file}:${f.line} — ${f.issue}`)
					.join("\n")}`,
				REVIEW_LEGS.verifier.port,
				"verifier",
				round,
			);
			if (!vRes.ok)
				return { arm: "b", findings: posted, verdict: "FAIL", roundsToPass: MAX_ROUNDS + 1, ...acc, ok: false, err: vRes.err };
			const kinds = parseVerify(vRes.text, rf.length);
			confirmed = rf.filter((_, i) => kinds[i] === "confirmed");
		}
		let blocking = confirmed;

		if (confirmed.length) {
			const tRes = await callLocal(
				acc,
				`${TRIAGE_FRAME}\n\nMISSION: ${task.mission}\n\nFINDINGS:\n${confirmed
					.map((f, i) => `${i + 1}. ${f.file}:${f.line} — ${f.issue}`)
					.join("\n")}`,
				REVIEW_LEGS.triage.port,
				"triage",
				round,
			);
			if (!tRes.ok)
				return { arm: "b", findings: posted, verdict: "FAIL", roundsToPass: MAX_ROUNDS + 1, ...acc, ok: false, err: tRes.err };
			const tags = parseTriage(tRes.text, confirmed.length);
			blocking = confirmed.filter((_, i) => tags[i] === "important");
		}
		for (const f of blocking) {
			const k = findKey(f);
			if (!postedKeys.has(k)) {
				postedKeys.add(k);
				posted.push(f);
			}
		}
		if (blocking.length === 0) {
			rounds = round;
			verdict = "PASS";
			break;
		}

		const primary = Object.keys(task.files?.buggy ?? {})[0];
		if (!primary) break;
		const findingsBlock = [...postedKeys].map((k) => `- ${k}`).join("\n");
		const fixRes = await callLocal(
			acc,
			`${FIXER_FRAME}\n\nFINDINGS:\n${findingsBlock}\n\nFILE ${primary}:\n${task.files?.buggy[primary] ?? ""}`,
			REVIEW_LEGS.fixer.port,
			"fixer",
			round,
		);
		const fixedText = fixRes.ok ? parseFix(fixRes.text) : null;
		if (!fixedText)
			return { arm: "b", findings: posted, verdict: "FAIL", roundsToPass: MAX_ROUNDS + 1, ...acc, ok: false, err: "fixer produced no patch" };
		const baseLines = (task.files?.fixed[primary] ?? "").split("\n");
		curDiff = unifiedDiff(primary, baseLines, fixedText.split("\n"));
	}
	return { arm: "b", findings: posted, verdict, roundsToPass: rounds, ...acc, ok: true };
}

export async function pingLocal(port: number): Promise<boolean> {
	const leg: Leg = { id: "local-direct", wire: "openai", priced: "local", desc: "review arena ping" };
	const q: Req = { user: "Reply with the single word: ready", maxTokens: 4, effort: null, timeoutMs: 30e3, port };
	const o = await callLeg(leg, q);
	return o.ok;
}
