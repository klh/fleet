// bench/w956 — round-2 identity-blind judging. Same seeded placement as
// round 1 (xyAssign, new seed), the judge (oracle :8903) scores each
// answer against the arm-neutral ground-truth memo without knowing
// which slot came from which arm. Round-2 scoring: per-key-point
// completeness rubric, ties SHOWN as ties (no forced pick), and both
// judge runs are recorded raw. Stamp metadata stays out of the judge
// input — the A/B measures retrieval, stamps are analyzed separately
// (arm-a.json / arm-b.json).
import { QUESTIONS, xyAssign } from "./questions.ts";

const IN = `${import.meta.dir}/results`;
const seed = 956;

interface Answers {
	[qid: string]: string;
}

const answersA: Answers = await Bun.file(`${IN}/answers-a.json`).json();
const answersB: Answers = await Bun.file(`${IN}/answers-b.json`).json();

const coins = xyAssign(seed, QUESTIONS.length);
const lines: string[] = [];
const index: Array<{
	qid: string;
	xFrom: "A" | "B";
}> = [];
QUESTIONS.forEach((q, i) => {
	const bankedInX = coins[i];
	const x = bankedInX ? answersA[q.id] : answersB[q.id];
	const y = bankedInX ? answersB[q.id] : answersA[q.id];
	lines.push(
		`### ${q.id} (${q.class})\nQ: ${q.q}\nGROUND TRUTH: ${q.gt}\nANSWER X: ${x}\nANSWER Y: ${y}\n`,
	);
	index.push({ qid: q.id, xFrom: bankedInX ? "A" : "B" });
});

const head = [
	"You are a blind judge. Per question you get the question, an",
	"arm-neutral ground-truth memo, and two candidate answers X and Y.",
	"Score EACH answer 0-5 correctness (contradicts the memo or invents",
	"specifics = lose points) and 0-5 completeness scored PER KEY POINT",
	"(enumerate the memo's key points; each covered = +1 up to 5, half-",
	"covered = +0.5, missed = 0). 'No answer' scores correctness 0.",
	"Output STRICT JSON array, one row per question:",
	'{"qid","x_c","x_k","y_c","y_k","pick"} where pick = "X" if X wins',
	"strictly, \"Y\" if Y wins strictly, \"tie\" on equal totals (ties are",
	"ties — never force a pick).",
].join("\n");

await Bun.write(`${IN}/judge-input.md`, `${head}\n\n${lines.join("\n")}`);
await Bun.write(
	`${IN}/judge-index.json`,
	JSON.stringify({ seed, index }, null, 2),
);
console.log(
	"judge input:",
	`${IN}/judge-input.md`,
	`(${QUESTIONS.length} questions)`,
);
