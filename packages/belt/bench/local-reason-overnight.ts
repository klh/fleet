#!/usr/bin/env bun
// local-reason-overnight.ts — the owner's 2026-10-06 directive: give the big
// local reasoner (:8903 Qwen3.5-35B-A3B-OptiQ-4bit) real tasks, let it run
// until tomorrow, and REGISTER tokens + performance + quality.
//
// Two tasks, alternating, one round every ~20 min until 08:00:
//   code   — implement parseDuration + tests (objective: does the test pass)
//   review — critically review hooks/lib/lane-liveness.ts (ground truth is
//            known: the W494 ghost fix; its findings get graded in the morning)
// Each round appends one JSONL line: tokens (usage), wall, tok/s, output file.
// Outputs land in bench/arena/local-reason-overnight/ (gitignored) for the
// morning's critical review. usage missing from a response is recorded as
// null — never estimated silently.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPECIALISTS } from "../bin/registry.ts";
import { ensureUp } from "../bin/spawner.ts";

const OUT = join(import.meta.dir, "arena/local-reason-overnight");
mkdirSync(OUT, { recursive: true });
const RESULTS = join(OUT, "results.jsonl");
type Leg = {
	route: string;
	url: string;
	model: string;
	keyFile?: string;
	wire: "openai" | "anthropic"; // pinned per leg — the :4000 router re-tiers by complexity, so local rides :8903's OpenAI wire directly
};
// local-reason rides the :4000 router (direct tier → :8903); zai rides the
// :4100 litellm group glm-5.3-flash (served-model recorded so a silent
// fallback to local never contaminates the z.ai column).
const LEGS: Leg[] = [
	{
		route: "local",
		url: "http://127.0.0.1:8903/v1/chat/completions",
		model: "mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit",
		wire: "openai",
	},
	{
		route: "zai",
		url: "http://127.0.0.1:4100/v1/messages",
		model: "glm-5.3-flash",
		keyFile: `${process.env.HOME}/.claude/local-llm/litellm.key`,
		wire: "anthropic",
	},
];

const laneLiveness = new URL(
	"../../suspenders/hooks/lib/lane-liveness.ts",
	import.meta.url,
).pathname;

const TASKS = {
	code: `Implement in TypeScript (strict, no deps): parseDuration(s: string): number | null —
accepts compositions like "1h30m", "45s", "2d", "1h 30m", "90m" (units d/h/m/s, case-insensitive,
whitespace-tolerant, order flexible within one string). Returns total seconds, or null on any
malformed input (empty, unknown unit, negative, garbage). Then write bun tests covering: the happy
paths above, "1h30m" == 5400, malformed cases, and a composition with repeated units summing.
Output ONLY two fenced blocks: first the implementation, then the tests.`,
	review: `Review this TypeScript module critically — it is a lane-liveness oracle in an agent
fleet (three consumers share it). Look for: correctness bugs, false-positive/false-negative
liveness paths, performance traps (it runs every dispatch cycle), and API sharp edges. Be specific:
quote the line, name the failure mode, propose the fix. Do NOT pad — if the module is solid, say
where its limits are instead. Output: a numbered findings list, each with severity (high/med/low).

\`\`\`typescript
${(await Bun.file(laneLiveness).text()).slice(0, 9000)}
\`\`\``,
} as const;

type Round = {
	ts: string;
	task: keyof typeof TASKS;
	route: string;
	servedModel: string | null;
	wallMs: number;
	promptTokens: number | null;
	completionTokens: number | null;
	tokS: number | null;
	outBytes: number;
	outFile: string;
	ok: boolean;
	error?: string;
};

const runLeg = async (leg: Leg, task: keyof typeof TASKS): Promise<Round> => {
	const t0 = Date.now();
	const key = leg.keyFile
		? await Bun.file(leg.keyFile)
				.text()
				.then((s) => s.trim())
				.catch(() => undefined)
		: undefined;
	const base: Round = {
		ts: new Date().toISOString(),
		task,
		route: leg.route,
		servedModel: null,
		wallMs: 0,
		promptTokens: null,
		completionTokens: null,
		tokS: null,
		outBytes: 0,
		outFile: "",
		ok: false,
	};
	try {
		// Local leg pins :8903's OpenAI wire directly (the :4000 router re-tiers
		// by complexity and would silently hand the task to the 4B extract —
		// measured 2026-10-07: model:"local-reason" → _routing.port 8902).
		// zai rides :4100 Anthropic wire (litellm passthrough).
		const openai = leg.wire === "openai";
		const r = await fetch(leg.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(openai ? {} : { "anthropic-version": "2023-06-01" }),
				...(key ? { "x-api-key": key } : {}),
			},
			body: JSON.stringify({
				model: leg.model,
				// z.ai gets an effectively unbounded budget (owner: enough to
				// burn; the API clamps to the model's real max) — the original
				// 4096 was consumed by glm's thinking alone and truncated every
				// round. Local stays bounded by its own context window reality.
				max_tokens: leg.wire === "openai" ? 32768 : 1_000_000,
				temperature: 0.2,
				messages: [{ role: "user", content: TASKS[task] }],
			}),
		});
		const b = (await r.json()) as {
			model?: string;
			content?: { text?: string }[];
			choices?: { message?: { content?: string } }[];
			usage?: {
				input_tokens?: number;
				output_tokens?: number;
				prompt_tokens?: number;
				completion_tokens?: number;
			};
		};
		const text = openai
			? (b.choices?.[0]?.message?.content ?? "")
			: (b.content ?? []).map((c) => c.text ?? "").join("");
		const wallMs = Date.now() - t0;
		const ct = openai
			? (b.usage?.completion_tokens ?? b.usage?.output_tokens ?? null)
			: (b.usage?.output_tokens ?? null);
		const pt = openai
			? (b.usage?.prompt_tokens ?? b.usage?.input_tokens ?? null)
			: (b.usage?.input_tokens ?? null);
		const seq = new Date().toISOString().replace(/[:.]/g, "-");
		const outFile = join(OUT, `${task}-${leg.route}-${seq}.md`);
		writeFileSync(outFile, text);
		return {
			...base,
			servedModel: b.model ?? null,
			wallMs,
			promptTokens: pt,
			completionTokens: ct,
			tokS: ct && wallMs ? Number(((ct / wallMs) * 1000).toFixed(1)) : null,
			outBytes: text.length,
			outFile,
			ok: r.ok && text.length > 0,
			error: r.ok ? undefined : `HTTP ${r.status}`,
		};
	} catch (e) {
		return { ...base, wallMs: Date.now() - t0, error: String(e).slice(0, 140) };
	}
};

const until = new Date();
until.setHours(8, 0, 0, 0);
if (until.getTime() < Date.now()) until.setDate(until.getDate() + 1);

appendFileSync(
	RESULTS,
	`${JSON.stringify({ type: "meta", start: new Date().toISOString(), until: until.toISOString(), legs: LEGS.map((l) => ({ route: l.route, model: l.model })) })}\n`,
);

const order: (keyof typeof TASKS)[] = ["code", "review"];
let i = 0;
while (Date.now() < until.getTime()) {
	const task = order[i % order.length];
	// Cold-load :8903 through the spawner before the local leg — the direct
	// wire has no router behind it, so the bench owns the ensureUp (and
	// inherits the ledger/budget guards with it).
	const reason = SPECIALISTS.find((s) => s.port === 8903);
	let localLegUp = true;
	if (reason) {
		const ens = await ensureUp(reason);
		localLegUp = ens.up;
		if (!ens.up) {
			appendFileSync(
				RESULTS,
				`${JSON.stringify({ type: "skip", route: "local", why: ens.error })}\n`,
			);
			console.log(`local leg skipped: ${ens.error}`);
		}
	}
	for (const leg of LEGS) {
		if (leg.route === "local" && !localLegUp) continue;
		const round = await runLeg(leg, task);
		appendFileSync(RESULTS, `${JSON.stringify(round)}\n`);
		console.log(
			`${round.ts} ${task}/${round.route} ok=${round.ok} wall=${round.wallMs}ms tokS=${round.tokS ?? "?"} served=${round.servedModel ?? "?"} out=${round.outBytes}B ${round.error ?? ""}`,
		);
	}
	i++;
	if (Date.now() < until.getTime())
		await Bun.sleep(20 * 60_000 + Math.floor(Math.random() * 60_000));
}
appendFileSync(
	RESULTS,
	`${JSON.stringify({ type: "done", at: new Date().toISOString(), rounds: i })}\n`,
);
console.log("overnight complete:", i, "rounds");
