// tests/review-eval/judge.ts — W1172 private-judge leg.
// The judge is the ONLY scorer of agent review outputs: a pinned rubric
// (machine-local 0600 prompt file) over the planted-issue inventory. The
// rubric bytes never enter the repo; the judge route/model are machine
// pins (config-over-code). One bounded attempt per output; a failed judge
// leg records score=null on that run instead of guessing.
import type { JudgeScore } from "./receipt.ts";

export type JudgeOpts = {
	url: string;
	key: string;
	model: string;
	prompt: string;
	ask: string;
	fileName: string;
	fileContent: string;
	reviewOutput: string;
};

export type JudgeResult = {
	score: JudgeScore | null;
	usage: { input: number; output: number };
};

const JUDGE_TIMEOUT_MS = 120_000;

/** Extract and parse the first balanced JSON object in a judge reply. */
export function parseJudgeJson(text: string): JudgeScore | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1)) as JudgeScore;
		} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/** Assemble the judge user-message: rubric + task + file + output. */
export function buildJudgeContent(opts: JudgeOpts): string {
	return [
		opts.prompt,
		"## Task ask given to the reviewer",
		opts.ask,
		"## File under review",
		`File name: ${opts.fileName}`,
		"```",
		opts.fileContent,
		"```",
		"## Reviewer output to score",
		"```",
		opts.reviewOutput,
		"```",
		"Reply with ONLY the JSON object the rubric defines.",
	].join("\n");
}

/** One bounded judge leg: POST the rubric packet, parse the score JSON. */
export async function judgeOutput(opts: JudgeOpts): Promise<JudgeResult> {
	const res = await fetch(opts.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${opts.key}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages: [{ role: "user", content: buildJudgeContent(opts) }],
		}),
		signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
	});
	if (!res.ok) {
		return { score: null, usage: { input: 0, output: 0 } };
	}
	const body = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const text = body.choices?.[0]?.message?.content ?? "";
	return {
		score: parseJudgeJson(text),
		usage: {
			input: body.usage?.prompt_tokens ?? 0,
			output: body.usage?.completion_tokens ?? 0,
		},
	};
}
