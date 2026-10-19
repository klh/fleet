// bench/w949 — identity-blind judging. Composes the judge input from the
// two arms' composed answers: per question, a seeded coin (xyAssign)
// places the banked-arm answer in slot X or Y; the judge (oracle :8903)
// scores each answer against the arm-neutral ground-truth memo without
// knowing which slot came from which arm.
import { QUESTIONS, xyAssign } from "./questions.ts";

const IN = `${import.meta.dir}/results`;
const seed = 949;

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
	"Score EACH answer 0-5 correctness (contradicts memo or invents",
	"specifics = lose points) and 0-5 completeness (coverage of the memo's",
	"key points). 'No answer' scores correctness 0. Output STRICT JSON",
	'array, one row per question: {"qid","x_c","x_k","y_c","y_k","pick"}',
	"where pick = 'X' or 'Y' (the per-question winner by total score; ties → X).",
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
