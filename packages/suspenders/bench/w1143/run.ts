// bench/w1143/run.ts — W1143 race-vs-single benchmark runner.
// Arms: strong-single (:8903 ×1, temp 0) · cheap-single (:8902 ×1, temp 0) ·
// race3 (3 concurrent :8902 attempts at temp 0.7 → fresh-context blind
// pairwise tournament on :8903 + skeptic per-rule verify → winner scored by
// the same mechanical checker as the singles). race3-oracle (best-of-3 by
// the mechanical checker, zero extra cost) is the no-judge upper bound.
// Gates: refuses without /tmp/bench-ac-ok (operator-owned) or a broken
// manifest; the live run stays deferred while the capacity observation holds.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	AC_FILE,
	CHARS_PER_TOK_TEXT,
	type Check,
	CLASSES,
	decisionPrompt,
	sha,
	stripThink,
	TASK_DIR,
} from "../../../belt/bench/arena/core.ts";
import { load1 } from "../../../belt/bench/arena/legs.ts";
import { loadTasks, verifyManifest } from "../../../belt/bench/arena/seal.ts";
import { scoreText, type Score } from "../../../belt/bench/arena/scoring.ts";
import {
	runTournament,
	type Attempt,
	type JudgeCall,
	type TournamentResult,
} from "./tournament.ts";

export const ATTEMPT_PORT = 8902; // cheap tier: race attempts + cheap arm
export const STRONG_PORT = 8903; // strong arm + judge + skeptic tier
export const RACE_TEMP = 0.7; // race attempts sample; singles stay greedy
export const RACE_LANES = 3;
export const JUDGE_MAX_TOKENS = 1024;
export const W1143_CLASSES = ["b", "e"] as const;
export type W1143Class = (typeof W1143_CLASSES)[number];
export interface ModelReply {
	ok: boolean;
	status: number;
	text: string;
	wall: number;
	inTok: number;
	outTok: number;
	tokEst: boolean;
	err?: string;
}

const failReply = (status: number, wall: number, err: string): ModelReply => ({
	ok: false,
	status,
	text: "",
	wall,
	inTok: 0,
	outTok: 0,
	tokEst: false,
	err,
});

/** Minimal openai-wire client for the local tiers — fresh context per call
 * (stream:false). Tokens: real usage when the tier reports it, chars/3.6
 * estimate with tokEst set when not. */
export async function callModel(
	port: number,
	prompt: string,
	o: { maxTokens: number; temp: number; timeoutMs: number },
): Promise<ModelReply> {
	const t0 = performance.now();
	const wall = () => Math.round(performance.now() - t0);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "default",
				messages: [{ role: "user", content: prompt }],
				max_tokens: o.maxTokens,
				temperature: o.temp,
				stream: false,
			}),
			signal: AbortSignal.timeout(o.timeoutMs),
		});
		if (!res.ok) return failReply(res.status, wall(), `HTTP ${res.status}`);
		const j = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const text = j.choices?.[0]?.message?.content ?? "";
		const i = j.usage?.prompt_tokens;
		const k = j.usage?.completion_tokens;
		return {
			ok: true,
			status: res.status,
			text,
			wall: wall(),
			inTok: i ?? Math.round(prompt.length / CHARS_PER_TOK_TEXT),
			outTok: k ?? Math.round(text.length / CHARS_PER_TOK_TEXT),
			tokEst: i === undefined || k === undefined,
		};
	} catch (e) {
		return failReply(0, wall(), e instanceof Error ? e.message : String(e));
	}
}

/** The sealed task's prompt for the W1143 classes: b rides its code-gen
 * prompt, e rides the sealed decision question. */
export const attemptPrompt = (
	cls: W1143Class,
	prompt: string | undefined,
	text: string | undefined,
): string => (cls === "b" ? (prompt ?? "") : decisionPrompt(text ?? ""));

/** The tournament's judge transport: :8903, fresh context per call, token
 * and wall accounting in the closure. Transport failures surface as
 * unparseable JSON so the tournament records them honestly (tie + error). */
export const judgeTransport = (): {
	call: JudgeCall;
	tokens: () => { inTok: number; outTok: number; wall: number };
} => {
	let inTok = 0;
	let outTok = 0;
	let wall = 0;
	const call: JudgeCall = async (prompt) => {
		const r = await callModel(STRONG_PORT, prompt, {
			maxTokens: JUDGE_MAX_TOKENS,
			temp: 0,
			timeoutMs: 600e3,
		});
		inTok += r.inTok;
		outTok += r.outTok;
		wall += r.wall;
		return r.ok
			? r.text
			: JSON.stringify({ error: r.err ?? `HTTP ${r.status}` });
	};
	return { call, tokens: () => ({ inTok, outTok, wall }) };
};

export type ArmName = "strong" | "cheap" | "race";

/** One NDJSON attempt row: the arm, the call economics, the mechanical
 * verdict — and the sampled system load at completion. */
export interface AttemptRow {
	type: "attempt";
	arm: ArmName;
	cls: W1143Class;
	task: string;
	attempt: string;
	port: number;
	temp: number;
	ok: boolean;
	wall: number;
	inTok: number;
	outTok: number;
	tokEst: boolean;
	score: number | null;
	pass: boolean | null;
	detail?: string;
	load1: number;
}

/** Build an attempt row from a reply + its mechanical score (null when the
 * call itself failed). */
export const rowOf = (
	arm: ArmName,
	attempt: string,
	cls: W1143Class,
	task: string,
	port: number,
	temp: number,
	r: ModelReply,
	s: Score | null,
): AttemptRow => ({
	type: "attempt",
	arm,
	cls,
	task,
	attempt,
	port,
	temp,
	ok: r.ok,
	wall: r.wall,
	inTok: r.inTok,
	outTok: r.outTok,
	tokEst: r.tokEst,
	score: s?.score ?? null,
	pass: s?.pass ?? null,
	...(r.err ? { detail: r.err } : s?.detail ? { detail: s.detail } : {}),
	load1: load1(),
});

/** One greedy single-shot arm (strong or cheap): one call at temp 0, scored
 * by the mechanical checker. */
export async function runSingle(
	arm: Exclude<ArmName, "race">,
	cls: W1143Class,
	task: string,
	check: Check,
	prompt: string,
): Promise<AttemptRow> {
	const port = arm === "strong" ? STRONG_PORT : ATTEMPT_PORT;
	const spec = CLASSES[cls];
	const r = await callModel(port, prompt, {
		maxTokens: spec.maxTokens,
		temp: 0,
		timeoutMs: spec.timeoutMs,
	});
	const s = r.ok ? await scoreText(check, stripThink(r.text)) : null;
	return rowOf(arm, arm === "strong" ? "s1" : "c1", cls, task, port, 0, r, s);
}

/** One race arm outcome: every attempt row, the judge tournament, the
 * skeptic-verified winner, the mechanical best-of-N oracle (zero extra
 * cost), and the queue-serialization honesty number. */
export interface RaceOutcome {
	attempts: AttemptRow[];
	tournament: TournamentResult | null;
	winner: string | null;
	winnerScore: number | null;
	winnerPass: boolean | null;
	oracle: string | null;
	oracleScore: number | null;
	/** judge token + wall accounting (coordination overhead) */
	judgeTok: { inTok: number; outTok: number; wall: number };
	/** sum/max of attempt walls: 1 = fully parallel, ≈lanes = serialized */
	serial: number;
}

/** The race arm: `lanes` concurrent cheap-tier attempts at RACE_TEMP, every
 * attempt mechanically scored, then the fresh-context blind tournament
 * picks the winner the skeptic lets through. The oracle (mechanical
 * best-of-N) rides the same calls — zero extra cost. */
export async function runRace(
	cls: W1143Class,
	task: string,
	check: Check,
	prompt: string,
	lanes: number,
	seed: string,
): Promise<RaceOutcome> {
	const spec = CLASSES[cls];
	const replies = await Promise.all(
		Array.from({ length: lanes }, (_, i) =>
			callModel(ATTEMPT_PORT, prompt, {
				maxTokens: spec.maxTokens,
				temp: RACE_TEMP,
				timeoutMs: spec.timeoutMs,
			}).then((r) => ({ r, id: `r${i + 1}` })),
		),
	);
	const attempts: AttemptRow[] = [];
	const scores = new Map<string, Score | null>();
	let oracle: string | null = null;
	let best = -1;
	for (const { r, id } of replies) {
		const s = r.ok ? await scoreText(check, stripThink(r.text)) : null;
		scores.set(id, s);
		if (s && s.score > best) {
			best = s.score;
			oracle = id;
		}
		attempts.push(rowOf("race", id, cls, task, ATTEMPT_PORT, RACE_TEMP, r, s));
	}
	const okAttempts: Attempt[] = replies.flatMap(({ r, id }) =>
		r.ok ? [{ id, answer: r.text }] : [],
	);
	const jt = judgeTransport();
	const tournament = okAttempts.length
		? await runTournament(task, okAttempts, jt.call, seed)
		: null;
	const w = tournament?.winner ? scores.get(tournament.winner) : null;
	const walls = replies.map((x) => x.r.wall);
	const max = Math.max(0, ...walls);
	const sum = walls.reduce((a, b) => a + b, 0);
	return {
		attempts,
		tournament,
		winner: tournament?.winner ?? null,
		winnerScore: w?.score ?? null,
		winnerPass: w?.pass ?? null,
		oracle,
		oracleScore: oracle ? best : null,
		judgeTok: jt.tokens(),
		serial: max > 0 ? +(sum / max).toFixed(2) : 0,
	};
}

/** One NDJSON line per row (streams law: append, never rewrite). */
export const ndjson = (path: string, row: unknown): void =>
	appendFileSync(path, `${JSON.stringify(row)}\n`);

/** The run's NDJSON sink: bench/w1143/results/w1143-<ts>.jsonl. */
export const resultsPath = (ts: string): string =>
	join(import.meta.dir, "results", `w1143-${ts}.jsonl`);

/** Tier liveness preflight — a short /v1/models probe per port. */
export const preflight = async (ports: number[]): Promise<string | null> => {
	const bad: string[] = [];
	for (const p of ports) {
		try {
			const r = await fetch(`http://127.0.0.1:${p}/v1/models`, {
				signal: AbortSignal.timeout(5e3),
			});
			if (!r.ok) bad.push(`:${p} HTTP ${r.status}`);
		} catch (e) {
			bad.push(`:${p} ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return bad.length ? `tier preflight failed — ${bad.join("; ")}` : null;
};

/** Run gates, refusal message or null: the operator-owned AC gate (the
 * same file the belt arena honors) and the sealed task manifest. */
export const gateRefusal = (): string | null => {
	if (!existsSync(AC_FILE))
		return `${AC_FILE} missing — operator-owned AC gate; W1143 live run stays deferred`;
	const man = verifyManifest(TASK_DIR);
	if (!man.ok)
		return `task manifest verify FAILED (hash ${man.hash}) — ${man.rows.filter((r) => r.includes("FAIL"))[0] ?? "see MANIFEST.json"}`;
	return null;
};

/** One sealed task's complete three-arm outcome. */
export interface TaskOutcome {
	cls: W1143Class;
	task: string;
	strong: AttemptRow;
	cheap: AttemptRow;
	race: RaceOutcome;
}

/** Per arm × class aggregate — the decision-grade comparison unit. */
export interface ArmSummary {
	arm: ArmName;
	cls: W1143Class;
	n: number;
	passes: number;
	passRate: number;
	meanScore: number;
	/** honest race wall = max(attempt walls) + judge wall */
	meanWall: number;
	outTok: number;
	/** judge output tokens (race coordination overhead) */
	judgeOutTok: number;
	meanSerial: number;
}

interface PerArm {
	pass: boolean;
	score: number;
	wall: number;
	out: number;
	serial: number;
}

/** One outcome's per-arm projection: the singles read their own row; the
 * race reads its skeptic-verified winner and pays max(attempt walls) +
 * judge wall — the honest end-to-end wall under concurrency. */
const perOf = (arm: ArmName, x: TaskOutcome): PerArm => {
	if (arm !== "race") {
		const row = arm === "cheap" ? x.cheap : x.strong;
		return {
			pass: row.pass === true,
			score: row.score ?? 0,
			wall: row.wall,
			out: row.outTok,
			serial: 1,
		};
	}
	const aw = x.race.attempts.map((a) => a.wall);
	return {
		pass: x.race.winnerPass === true,
		score: x.race.winnerScore ?? 0,
		wall: Math.max(0, ...aw) + x.race.judgeTok.wall,
		out:
			x.race.attempts.reduce((a, b) => a + b.outTok, 0) +
			x.race.judgeTok.outTok,
		serial: x.race.serial,
	};
};

/** Aggregate every completed outcome into per arm × class summaries. */
export const summarize = (xs: TaskOutcome[]): ArmSummary[] => {
	const out: ArmSummary[] = [];
	for (const arm of ["strong", "cheap", "race"] as const) {
		for (const cls of W1143_CLASSES) {
			const sel = xs.filter((x) => x.cls === cls);
			const per = sel.map((x) => perOf(arm, x));
			const n = Math.max(1, per.length);
			const mean = (f: (p: PerArm) => number): number =>
				+(per.reduce((a, p) => a + f(p), 0) / n).toFixed(4);
			out.push({
				arm,
				cls,
				n: sel.length,
				passes: per.filter((p) => p.pass).length,
				passRate: mean((p) => (p.pass ? 1 : 0)),
				meanScore: mean((p) => p.score),
				meanWall: Math.round(mean((p) => p.wall)),
				outTok: per.reduce((a, p) => a + p.out, 0),
				judgeOutTok:
					arm === "race"
						? sel.reduce((a, x) => a + x.race.judgeTok.outTok, 0)
						: 0,
				meanSerial: mean((p) => p.serial),
			});
		}
	}
	return out;
};

export interface RunArgs {
	classes: W1143Class[];
	n: number;
	lanes: number;
}

/** `--classes b,e` · `--n 12` (per class, capped to the sealed set) ·
 * `--lanes 3`. Bun strips `--`, so flags are read directly. Absent numeric
 * flags fall back to their default (`Number(null)` = 0 passes `|| fb`). */
export const parseArgs = (argv: string[]): RunArgs => {
	let classes: W1143Class[] = [...W1143_CLASSES];
	let n = 12;
	let lanes = RACE_LANES;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--classes")
			classes = (argv[i + 1] ?? "")
				.split(",")
				.filter((c): c is W1143Class =>
					(W1143_CLASSES as readonly string[]).includes(c),
				);
		else if (a === "--n") n = Number(argv[i + 1]);
		else if (a === "--lanes") lanes = Number(argv[i + 1]);
	}
	if (!classes.length) classes = [...W1143_CLASSES];
	return {
		classes,
		n: Math.min(130, Math.max(1, n || 12)),
		lanes: Math.min(8, Math.max(1, lanes || RACE_LANES)),
	};
};

/** The bench run: gates → per class → per task {strong, cheap, race} →
 * NDJSON rows + end summary. Exit 3 on a refused gate. */
export const main = async (argv: string[]): Promise<number> => {
	const refuse = gateRefusal();
	if (refuse) {
		console.error(`refusing: ${refuse}`);
		return 3;
	}
	const pf = await preflight([ATTEMPT_PORT, STRONG_PORT]);
	if (pf) {
		console.error(`refusing: ${pf}`);
		return 3;
	}
	const { classes, n, lanes } = parseArgs(argv);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const path = resultsPath(ts);
	mkdirSync(join(import.meta.dir, "results"), { recursive: true });
	ndjson(path, { type: "run", ts, classes, n, lanes, load1: load1() });
	const outcomes: TaskOutcome[] = [];
	for (const cls of classes) {
		for (const t of loadTasks(cls, TASK_DIR).tasks.slice(0, n)) {
			const prompt = attemptPrompt(cls, t.prompt, t.text);
			const seed = sha(`${ts}|${cls}|${t.id}`).slice(0, 12);
			const strong = await runSingle("strong", cls, t.id, t.check, prompt);
			const cheap = await runSingle("cheap", cls, t.id, t.check, prompt);
			const race = await runRace(cls, t.id, t.check, prompt, lanes, seed);
			outcomes.push({ cls, task: t.id, strong, cheap, race });
			for (const row of [strong, cheap, ...race.attempts]) ndjson(path, row);
			ndjson(path, {
				type: "tournament",
				cls,
				task: t.id,
				ranking: race.tournament?.ranking ?? [],
				winner: race.winner,
				oracle: race.oracle,
				oracleScore: race.oracleScore,
				winnerPass: race.winnerPass,
				judgeCalls: race.tournament?.judgeCalls ?? 0,
				judge: race.judgeTok,
				serial: race.serial,
			});
			console.log(
				`${cls}/${t.id} strong=${strong.pass} cheap=${cheap.pass} race=${race.winnerPass} oracle=${race.oracle}:${race.oracleScore}`,
			);
		}
	}
	const summary = summarize(outcomes);
	ndjson(path, { type: "summary", ts, summary });
	console.log(
		"ARM      CLS  N   PASS  RATE    SCORE  WALLms  OUT-TOK  JUDGE-TOK  SERIAL",
	);
	for (const s of summary)
		console.log(
			`${s.arm.padEnd(8)} ${s.cls}    ${String(s.n).padStart(2)}  ${String(s.passes).padStart(4)}  ${s.passRate.toFixed(2)}   ${s.meanScore.toFixed(2)}   ${String(s.meanWall).padStart(6)}  ${String(s.outTok).padStart(7)}  ${String(s.judgeOutTok).padStart(9)}   ${s.meanSerial.toFixed(2)}`,
		);
	console.log(`rows: ${path}`);
	return 0;
};

if (import.meta.main) process.exitCode = await main(process.argv);
