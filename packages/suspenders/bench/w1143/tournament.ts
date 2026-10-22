// bench/w1143/tournament.ts — W1143 race selection: fresh-context blind
// pairwise tournament + skeptic per-rule verify. Lifted from the
// dynamic-workflow guard lessons (claude.dev a-harness-for-every-task,
// read 2026-10-22): per-rule verification in fresh context + a skeptic
// pass on the judge tier; self-preferential bias guarded by blind slots
// (the judge never sees attempt ids, arms or temperature) and randomized
// presentation order per comparison.
import { type R, rng, sha } from "../../../belt/bench/arena/core.ts";
import { capMiddle } from "../../../belt/bench/arena/judge.ts";

export interface Attempt {
	id: string;
	answer: string;
}
export interface PairVerdict {
	winner: "A" | "B" | "tie";
	reason: string;
}
export interface SkepticVerdict {
	comply: boolean;
	violations: string[];
}
export type JudgeCall = (prompt: string) => Promise<string>;

/** Blind slots: randomized A/B presentation via a seed derived from the
 *  task + pair, so the same pair can flip slots across tasks. */
const slotCoin = (task: string, aId: string, bId: string, seed: string): R =>
	rng(sha(`${seed}|${task.length}|${aId}|${bId}`).slice(0, 12));

const fmtBlock = (label: string, body: string) =>
	`${label}:\n"""\n${capMiddle(body, 16_000)}\n"""`;

export const pairPrompt = (task: string, ansA: string, ansB: string): string =>
	`You are judging two responses to the same task for a benchmark. Decide which response better fulfils the task: instruction and format compliance first, then correctness and completeness; padding, refusals or drift are failures.\n\n${fmtBlock("TASK", task)}\n\n${fmtBlock("RESPONSE A", ansA)}\n\n${fmtBlock("RESPONSE B", ansB)}\n\nReply with ONLY this JSON object, no other text:\n{"winner": "A" | "B" | "tie", "reason": "<one sentence>"}`;

const extractJson = (raw: string): Record<string, unknown> | null => {
	const a = raw.indexOf("{");
	const b = raw.lastIndexOf("}");
	if (a < 0 || b <= a) return null;
	try {
		return JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
};
export const parsePair = (raw: string): PairVerdict | null => {
	const j = extractJson(raw);
	if (!j) return null;
	const w = String(j.winner ?? "").toLowerCase();
	if (w !== "a" && w !== "b" && w !== "tie") return null;
	return {
		winner: w,
		reason: String(j.reason ?? "").slice(0, 240),
	};
};
export const skepticPrompt = (task: string, answer: string): string =>
	`You are a skeptical verifier for a benchmark. Check the CANDIDATE RESPONSE against EVERY explicit requirement in the task, rule by rule. A requirement is violated when the response does not follow it exactly; anything unstated is not a violation. comply is true only when no requirement is violated.\n\n${fmtBlock("TASK", task)}\n\n${fmtBlock("CANDIDATE RESPONSE", answer)}\n\nReply with ONLY this JSON object, no other text:\n{"comply": true | false, "violations": ["<requirement violated>"]}`;
export const parseSkeptic = (raw: string): SkepticVerdict | null => {
	const j = extractJson(raw);
	if (!j) return null;
	if (typeof j.comply !== "boolean") return null;
	if (
		j.violations !== undefined &&
		(!Array.isArray(j.violations) ||
			!j.violations.every((v) => typeof v === "string"))
	)
		return null;
	return {
		comply: j.comply,
		violations: Array.isArray(j.violations) ? (j.violations as string[]) : [],
	};
};
export interface Comparison {
	aId: string;
	bId: string;
	/** which attempt id sat in the (randomized) A slot */
	aSlot: string;
	winner: "A" | "B" | "tie";
	reason: string;
	error?: string;
}
export interface SkepticRecord {
	attempt: string;
	comply: boolean;
	violations: string[];
	error?: string;
}
export interface TournamentResult {
	/** attempt ids best-first after skeptic elimination */
	ranking: string[];
	winner: string | null;
	comparisons: Comparison[];
	skeptic: SkepticRecord[];
	judgeCalls: number;
}
/** One blind pairwise comparison: randomized slots, fresh context — the
 *  caller supplies the judge transport; wins/ties accumulate in `wins`. */
const comparePair = async (
	task: string,
	x: Attempt,
	y: Attempt,
	call: JudgeCall,
	seed: string,
	wins: Map<string, number>,
	comparisons: Comparison[],
): Promise<void> => {
	const a = slotCoin(task, x.id, y.id, seed)() < 0.5 ? x : y;
	const b = a === x ? y : x;
	const raw = await call(pairPrompt(task, a.answer, b.answer));
	const v = parsePair(raw);
	const wid = v?.winner === "A" ? a.id : v?.winner === "B" ? b.id : null;
	if (wid) wins.set(wid, (wins.get(wid) ?? 0) + 1);
	else {
		wins.set(x.id, (wins.get(x.id) ?? 0) + 0.5);
		wins.set(y.id, (wins.get(y.id) ?? 0) + 0.5);
	}
	comparisons.push({
		aId: x.id,
		bId: y.id,
		aSlot: a.id,
		winner: v?.winner ?? "tie",
		reason: v?.reason ?? "unparseable judge output",
		...(v ? {} : { error: raw.slice(0, 120) }),
	});
};
/** Round-robin pairwise tournament (fresh context per comparison, blind
 *  slots); winner selection: tally-ranked attempts, then skeptic per-rule
 *  verification with elimination — a vetoed leader is removed and the
 *  next-ranked attempt verified instead. winner=null = every attempt
 *  vetoed: the race fails honestly. */
export async function runTournament(
	task: string,
	attempts: Attempt[],
	call: JudgeCall,
	seed: string,
): Promise<TournamentResult> {
	const wins = new Map<string, number>();
	const comparisons: Comparison[] = [];
	const skeptic: SkepticRecord[] = [];
	for (let i = 0; i < attempts.length; i++) {
		for (let k = i + 1; k < attempts.length; k++) {
			const x = attempts[i];
			const y = attempts[k];
			if (x && y) await comparePair(task, x, y, call, seed, wins, comparisons);
		}
	}
	if (!attempts.length)
		return { ranking: [], winner: null, comparisons, skeptic, judgeCalls: 0 };
	const tally = (id: string) => wins.get(id) ?? 0;
	const ranking = attempts
		.map((a) => a.id)
		.sort((p, q) => tally(q) - tally(p) || p.localeCompare(q));
	let winner: string | null = null;
	for (const id of ranking) {
		const at = attempts.find((a) => a.id === id);
		const raw = await call(skepticPrompt(task, at?.answer ?? ""));
		const v = parseSkeptic(raw);
		skeptic.push({
			attempt: id,
			comply: v?.comply ?? false,
			violations: v?.violations ?? [],
			...(v ? {} : { error: raw.slice(0, 120) }),
		});
		if (v?.comply) {
			winner = id;
			break;
		}
	}
	return {
		ranking,
		winner,
		comparisons,
		skeptic,
		judgeCalls: comparisons.length + skeptic.length,
	};
}
