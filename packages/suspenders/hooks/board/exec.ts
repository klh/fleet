// hooks/board/exec.ts — lane exec helpers: runCli, lane exec facts, LLM routing (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { buckleChat } from "../lib/inference-buckle.ts";
import { db, WORK_CLI, COORD_CLI } from "./context.ts";

export const runCli = (
	args: string[],
	cwd?: string,
): { code: number; out: string } => {
	const p = Bun.spawnSync([process.execPath, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		...(cwd ? { cwd } : {}),
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
	};
};
// W105 — plumb executor+model+locality into the lane registry at dispatch
// time: facts lane.<sid>.executor / .model / .locality (governor.db), keyed
// by the sid the lane will bootstrap under (autow<id> for board dispatches).
// The board UI reads them back for the MODEL badges; direct facts-table
// writes are the same trust class as the board-owned decisions table.
export const laneExecFacts = (
	sid: string,
	executor: string,
	model: string,
	locality: string,
): void => {
	for (const [k, v] of [
		["executor", executor],
		["model", model],
		["locality", locality],
	] as const)
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, ts) VALUES (?, ?, 'fleet-board', ?)",
		).run(`lane.${sid}.${k}`, v, Date.now());
};
// W1119 — the ONE gated leg for board llm:* dispatches: the machine/model
// preference rides the W136 hint grammar as DATA ('prefer host:<machine>
// model:<id>' / 'prefer local model:<id>'), never a belt route-to shell or
// a direct :890x socket. Throws fail-closed (bounded error) — the caller
// lands llm.error on the thread and releases either way.
export async function gatedLlmAnswer(opts: {
	model: string;
	prompt: string;
	hint: string;
	env?: NodeJS.ProcessEnv;
	fetcher?: typeof fetch;
}): Promise<string> {
	const r = await buckleChat(
		{
			model: opts.model,
			user: opts.prompt,
			hint: opts.hint,
			timeoutMs: 120_000,
			...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
		},
		opts.env ?? process.env,
	);
	return r.text.trim();
}
// one llm:* dispatch: route the item's title+description through the gate
// with the user's machine+model pick riding as hint data (W224 — the user
// picks machine + model from the feed), land the answer on the item's coord
// thread, release the board claim either way. Fire-and-forget — the HTTP
// answer returns while belt routes. cwd = the item's repo: coord stamps
// payload.project from the cwd and the drawer timeline matches on it.
export const llmRoute = async (job: {
	item: string;
	repo: string;
	machine: string;
	port: number;
	model: string; // W224 catalog pick — the preference id on the wire
	target: string;
	sid: string;
	title: string;
	desc: string;
}): Promise<void> => {
	const prompt = `${job.title}${job.desc ? ` — ${job.desc}` : ""}`.slice(
		0,
		4000,
	);
	let ok = false;
	let answer = "";
	try {
		// W1119: the gated leg — the machine/model preference rides as the
		// W136 hint ('prefer host:<machine> model:<id>'), never a belt
		// route-to shell or a direct endpoint.
		answer = await gatedLlmAnswer({
			model: job.model,
			prompt,
			hint: `prefer host:${job.machine} model:${job.model}`,
		});
		ok = true;
	} catch (e) {
		answer = `route failed: ${e instanceof Error ? e.message : String(e)}`;
	}
	const note = `${ok ? "llm.answer" : "llm.error"} (${job.target}): ${answer.slice(0, 1800)}`;
	runCli(
		[
			COORD_CLI,
			"emit",
			"llm.result",
			"--scope",
			job.item,
			"--as",
			job.sid,
			"--note",
			note,
		],
		job.repo,
	);
	runCli([WORK_CLI, "release", job.item, "--as", job.sid], job.repo);
};
// W183.1 — one llm:local:<port> dispatch: the local-swarm preference rides
// the W136 hint ('prefer local model:<id>') through the same gated leg as
// llmRoute() — no direct :890x socket (W1119 decision.single-buckle-
// inference), the model id IS the selector data. Same
// land-the-answer-on-the-thread, release-either-way contract.
export const localSwarmChat = async (job: {
	item: string;
	repo: string;
	port: number;
	model: string;
	sid: string;
	title: string;
	desc: string;
}): Promise<void> => {
	const prompt = `${job.title}${job.desc ? ` — ${job.desc}` : ""}`.slice(
		0,
		4000,
	);
	let ok = false;
	let answer = "";
	try {
		// W1119: the gated leg — the local preference rides as hint data.
		answer = await gatedLlmAnswer({
			model: job.model,
			prompt,
			hint: `prefer local model:${job.model}`,
		});
		ok = true;
	} catch (e) {
		answer = `route failed: ${e instanceof Error ? e.message : String(e)}`;
	}
	const note = `${ok ? "llm.answer" : "llm.error"} (local:${job.model}): ${answer.slice(0, 1800)}`;
	runCli(
		[
			COORD_CLI,
			"emit",
			"llm.result",
			"--scope",
			job.item,
			"--as",
			job.sid,
			"--note",
			note,
		],
		job.repo,
	);
	runCli([WORK_CLI, "release", job.item, "--as", job.sid], job.repo);
};
// this install's wiring scripts — the setup checks look for THEM in
// ~/.claude/settings.json, not just any suspenders install
