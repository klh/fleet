// hooks/lib/contrastive-selection.ts — W927: the PURE selection/compose
// contract of the contrastive consult pool (selection.py port): seeded
// anonymized labels, the identity-blind compose prompt, the compose output
// contract, and the domain-grouping visibility rule. NO db import — unit
// tests import this without opening a store.
export const STAGE_ATTEMPTS = 2;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// seeded, deterministic LCG PRNG for the label shuffle (bigint, plain ops)
function lcg(seed: number): () => number {
	let a = BigInt(seed >>> 0) * 2654435761n + 1013904223n;
	return () => {
		a = (a * 6364136223846793005n + 1442695040888963407n) % 18446744073709551616n;
		return Number(a % 1000000007n) / 1000000007;
	};
}
// position → label: Fisher-Yates over the pool indexes, seeded by the
// consult id — the same consult always labels the same way
export function assignIds(cid: number, k: number): string[] {
	const rng = lcg(cid);
	const idx = Array.from({ length: k }, (_, i) => i);
	for (let i = k - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const a = idx[i] ?? i;
		const b = idx[j] ?? j;
		idx[i] = b;
		idx[j] = a;
	}
	return idx.map((poolIndex) => LETTERS[poolIndex] ?? "?");
}
// W927 domain grouping: a domain only ever sees same-domain entries —
// unscoped (empty) entries are visible everywhere; a domain-stamped consumer
// never sees another domain's rows
export function domainVisible(
	entry: string | null,
	consumer: string | null,
): boolean {
	const e = entry ?? "";
	const c = consumer ?? "";
	return c === "" ? e === "" : e === "" || e === c;
}
export const COMPOSE_FRAME = [
	"You are the compose stage of a contrastive consult (selection.py port).",
	"Below are k candidate answers to one question, labeled A/B/… and",
	"anonymized. Judge the text alone — rank on correctness, specificity and",
	"actionability. Pool rules: the candidates are exactly the k finals;",
	"there is no abstention by construction — you MUST pick one label.",
	"End your reply with ONE machine-parseable block:",
	"PICK: <label>",
	"WHY: <one line on why this candidate wins>",
	"CUE: <when a lane should reach for this answer>",
	"LESSON: <one-line distillation another lane can reuse>",
	"EVIDENCE: <pointer to the artifact this rests on: file:line, URL or ticket>",
	"CONFIDENCE: high|medium|low",
].join("\n");
// identity-blind by construction: the only inputs are the question and
// {label, text} pairs — no leg name, model id, or spend figure can enter
export function composePrompt(
	question: string,
	answers: { label: string; text: string }[],
): string {
	const cands = answers.map((a) => `[${a.label}]\n${a.text}`).join("\n\n");
	return `${COMPOSE_FRAME}\n\nQUESTION:\n${question}\n\nCANDIDATES:\n${cands}`;
}
export interface ComposedPick {
	pick: string;
	why: string;
	cue: string;
	lesson: string;
	evidence: string;
	confidence: string;
}
// the compose output contract — PICK against the label set, WHY + LESSON
// load-bearing; CONFIDENCE defaults low when the leg omits it
export function parseCompose(
	text: string,
	labels: string[],
): ComposedPick | null {
	const pick = text.match(/^PICK:\s*([A-Z])\b/m)?.[1] ?? null;
	if (!pick || !labels.includes(pick)) return null;
	if (!/^WHY:/m.test(text) || !/^LESSON:/m.test(text)) return null;
	const conf = text.match(/^CONFIDENCE:\s*(high|medium|low)\b/im)?.[1] ?? "low";
	return {
		pick,
		why: text.match(/^WHY:\s*(.+)$/m)?.[1] ?? "",
		cue: text.match(/^CUE:\s*(.+)$/m)?.[1] ?? "",
		lesson: text.match(/^LESSON:\s*(.+)$/m)?.[1] ?? "",
		evidence: text.match(/^EVIDENCE:\s*(.+)$/m)?.[1] ?? "",
		confidence: conf,
	};
}
