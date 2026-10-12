// src/eval/tasks-reasoning.ts — the reasoning shape bucket: multi-step word
// problems whose keys are computed from the generated operands.
import { metaOf, numCheck } from "./graders.ts";
import { makeRng, type Rng } from "./rng.ts";
import type { Task } from "./types.ts";

const SYSTEM =
	"You are a careful reasoner. Work it out, then reply with only the final answer — a single number or letter, no explanation.";

// ── families ──

/** Two-step inventory word problem: n1 boxes of k1 + n2 boxes of k2. */
function wordProblem(rng: Rng, i: number): Task {
	const n1 = 3 + rng.int(20);
	const k1 = 2 + rng.int(12);
	const n2 = 3 + rng.int(20);
	const k2 = 2 + rng.int(12);
	const key = n1 * k1 + n2 * k2;
	return {
		id: `reason-word-${String(i)}`,
		shape: "reasoning",
		system: SYSTEM,
		prompt: `A warehouse stocks ${String(n1)} shelves with ${String(k1)} crates each and ${String(n2)} shelves with ${String(k2)} crates each. How many crates in total?`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("word-problem"),
	};
}

/** Sequence next term: arithmetic (+d), geometric (×2), or alternating
 *  (+d then −e, period 2). */
function sequenceNext(rng: Rng, i: number): Task {
	const start = 2 + rng.int(9);
	const variant = rng.int(3);
	if (variant === 0) {
		const d = 2 + rng.int(7);
		const terms = Array.from({ length: 5 }, (_, t) => start + t * d);
		return seqTask(i, terms, start + 5 * d);
	}
	if (variant === 1) {
		const terms = Array.from({ length: 5 }, (_, t) => start * 2 ** t);
		return seqTask(i, terms, start * 2 ** 5);
	}
	const d = 2 + rng.int(6);
	const e = 2 + rng.int(6);
	const terms: number[] = [start];
	let prev = start;
	for (let t = 1; t < 5; t++) {
		prev = t % 2 === 1 ? prev + d : prev - e;
		terms.push(prev);
	}
	return seqTask(i, terms, prev + d);
}

function seqTask(i: number, terms: number[], key: number): Task {
	return {
		id: `reason-seq-${String(i)}`,
		shape: "reasoning",
		system: SYSTEM,
		prompt: `What is the next number in this sequence?\n${terms.map(String).join(", ")}, …`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("sequence-next"),
	};
}

/** Largest of four computed expressions → letter. */
function compareChain(rng: Rng, i: number): Task {
	const rows = Array.from({ length: 4 }, (_, t) => ({
		letter: (["A", "B", "C", "D"] as const)[t] as string,
		b: 2 + rng.int(12),
		m: 2 + rng.int(9),
	}));
	const scored = rows.map((r) => ({ ...r, v: r.b * r.m }));
	const best = scored.reduce(
		(acc, s) => (s.v > acc.v ? s : acc),
		scored[0] as (typeof scored)[number],
	);
	const parts = scored
		.map((s) => `${s.letter} = ${String(s.b)} × ${String(s.m)}`)
		.join(", ");
	return {
		id: `reason-cmp-${String(i)}`,
		shape: "reasoning",
		system: SYSTEM,
		prompt: `Which expression is the largest?\n${parts}\nReply with only the letter.`,
		key: best.letter,
		check: (answer) =>
			(answer
				.trim()
				.toUpperCase()
				.match(/[ABCD]/u)?.[0] ?? "") === best.letter,
		meta: metaOf("compare-chain"),
	};
}

/** Speed → minutes for a leg; m divisible by h, result integral. */
function travelTime(rng: Rng, i: number): Task {
	const h = 2 + rng.int(3);
	const speed = 10 + rng.int(20);
	const m = h * speed; // km total, so km/h = speed exactly
	const leg = 1 + rng.int(h * 2 - 1);
	const key = Math.round((leg / speed) * 60); // minutes for `leg` km
	return {
		id: `reason-travel-${String(i)}`,
		shape: "reasoning",
		system: SYSTEM,
		prompt: `A train covers ${String(m)} km in ${String(h)} hours at constant speed. How many minutes does it take to cover ${String(leg)} km?`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("travel-time"),
	};
}

/** Discount price; multiples keep the result integral. */
function discount(rng: Rng, i: number): Task {
	const price = (2 + rng.int(20)) * 100;
	const pct = [10, 20, 25, 50][rng.int(4)] as number;
	const key = price - (price * pct) / 100;
	return {
		id: `reason-disc-${String(i)}`,
		shape: "reasoning",
		system: SYSTEM,
		prompt: `A jacket costs ${String(price)} kr. With a ${String(pct)}% discount, what is the final price in kr?`,
		key: String(key),
		check: numCheck(key),
		meta: metaOf("discount"),
	};
}

const FAMILIES = [
	wordProblem,
	sequenceNext,
	compareChain,
	travelTime,
	discount,
];

export function makeReasoningTasks(n: number, seed: number): Task[] {
	const rng = makeRng(seed);
	return Array.from({ length: n }, (_, i) =>
		(FAMILIES[i % FAMILIES.length] as typeof wordProblem)(rng, i),
	);
}
