// runner.ts — W2871 MVP durable-runner: callback inference via muramasa buckle.
// Runs on the NAS in oven/bun:1. Writes transcript + since-last digest to /state.
// Secret arrives via --env-file (container env, never argv). No keys baked.
const HUB = process.env.HUB_URL ?? "http://127.0.0.1:4111"; // set HUB_URL to the hub face the carrier may reach
// W2871 security fix (review #117508): the runner carries a SCOPED lane key
// (BUCKLE_TOKEN, buckle:proxy:WRITE_), minted by the trusted orchestrator
// host — never the hub root key. Root key is accepted only for legacy env
// so old runs don't silently break; new deployments must set BUCKLE_TOKEN.
const KEY = process.env.BUCKLE_TOKEN ?? process.env.BUCKLE_ROOT_KEY ?? "";
const MODEL = process.env.RUNNER_MODEL ?? "glm-5.3-flash";
const STATE = "/state";
import { readFileSync } from "node:fs";
const BRIEF = process.env.TASK_BRIEF
	?? (process.env.TASK_BRIEF_FILE
		? readFileSync(process.env.TASK_BRIEF_FILE, "utf8")
		: "No task brief provided.");

const t0 = Date.now();
async function jlog(file: string, obj: unknown) {
	await Bun.write(
		`${STATE}/${file}`,
		JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n",
		{ append: true },
	);
}

async function callModel(label: string, messages: unknown[], maxTokens: number) {
	const s = Date.now();
	await jlog("transcript.jsonl", {
		event: "call:start",
		label,
		model: MODEL,
	});
	const res = await fetch(`${HUB}/v1/messages`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: MODEL,
			max_tokens: maxTokens,
			messages,
			...(process.env.REASONING_EFFORT !== "default"
				? { reasoning_effort: process.env.REASONING_EFFORT ?? "low" }
				: {}),
		}),
	});
	const ms = Date.now() - s;
	if (!res.ok) {
		const body = await res.text();
		await jlog("transcript.jsonl", {
			event: "call:error",
			label,
			status: res.status,
			body: body.slice(0, 400),
		});
		throw new Error(`${label}: HTTP ${res.status}`);
	}
	const json: any = await res.json();
	const text = (json.content ?? [])
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n");
	await jlog("transcript.jsonl", {
		event: "call:done",
		label,
		ms,
		usage: json.usage,
		stop_reason: json.stop_reason,
		text_len: text.length,
	});
	return { text, ms, usage: json.usage ?? {} };
}

await Bun.write(`${STATE}/transcript.jsonl`, "");
await jlog("transcript.jsonl", {
	event: "runner:boot",
	hub: HUB,
	model: MODEL,
	brief_len: BRIEF.length,
});

const exit: Record<string, unknown> = { ok: false };
try {
	const work = await callModel(
		"work",
		[
			{
				role: "user",
				content: `${BRIEF}\n\nYou are a durable runner working autonomously. Produce your deliverable now, complete and concrete.`,
			},
		],
		Number(process.env.RUNNER_MAX_TOKENS ?? 8192),
	);
	exit.work_ms = work.ms;
	exit.work_tokens = work.usage;

	if (process.env.SKIP_DIGEST === "1") {
		exit.total_ms = Date.now() - t0;
		exit.ok = true;
		await Bun.write(`${STATE}/work.md`, work.text);
		await Bun.write(`${STATE}/exit.json`, JSON.stringify(exit, null, 2) + "\n");
		await jlog("transcript.jsonl", { event: "runner:exit", ...exit });
		console.log(JSON.stringify(exit));
		process.exit(0);
	}

	const digest = await callModel(
		"digest",
		[
			{
				role: "user",
				content: `A worker was given this task:\n${BRIEF}\n\nThe worker produced:\n${work.text}\n\nWrite a SINCE-LAST digest in markdown with sections: Task, Produced (2-4 bullets), Blockers (or "none"), Next steps (2-3 bullets). Be terse.`,
			},
		],
		1024,
	);
	exit.digest_ms = digest.ms;
	exit.total_ms = Date.now() - t0;
	exit.ok = true;

	await Bun.write(`${STATE}/work.md`, work.text);
	await Bun.write(`${STATE}/digest.md`, digest.text);
} catch (e: any) {
	exit.error = String(e?.message ?? e);
	exit.total_ms = Date.now() - t0;
}
exit.finished = new Date().toISOString();
await Bun.write(`${STATE}/exit.json`, JSON.stringify(exit, null, 2) + "\n");
await jlog("transcript.jsonl", { event: "runner:exit", ...exit });
console.log(JSON.stringify(exit));
