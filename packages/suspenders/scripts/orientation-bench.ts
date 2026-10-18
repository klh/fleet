#!/usr/bin/env bun
// orientation-bench.ts — W454 Phase 1/3 benchmark: orientation cost per
// harness, cold vs starter-forked lane start.
//
//   bun scripts/orientation-bench.ts [--harness claude] [--runs 3]
//       [--phase pre|post] [--repo <dir>] [--out <dir>] [--timeout <ms>]
//
// Each run spawns the harness with a deterministic FIRST PRODUCTIVE ACTION
// (run `git rev-parse HEAD`, reply with the sha) and records wall clock
// plus the token split parsed from the harness JSON result. What a harness
// does not expose, the record leaves null — never guessed.
//
// NDJSON records land in .fleet/orientation-bench/<phase>-<harness>.ndjson
// (streams law). Exit: 0 = completed, 3 = harness unavailable, 4 = no
// usable result parsed.
import { mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureStarter, starterEnabledFor } from "./lib/lane-starter.ts";

type BenchRecord = {
	ts: number;
	phase: string;
	harness: string;
	mode: "cold" | "fork";
	run: number;
	wall_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read: number | null;
	cache_creation: number | null;
	session_id: string | null;
	task: string;
	error?: string;
};

type ForkLike = { sessionId: string; forkArgs: string[] };
type ProbeReading = {
	ok: boolean;
	wall_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read: number | null;
	cache_creation: number | null;
	session_id: string | null;
};

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const HARNESS = arg("harness") ?? "claude";
const RUNS = Number(arg("runs") ?? 3);
const PHASE = arg("phase") ?? "pre";
const REPO = resolve(arg("repo") ?? process.cwd());
const OUT = resolve(arg("out") ?? join(REPO, ".fleet", "orientation-bench"));
const TIMEOUT = Number(arg("timeout") ?? 240_000);

// Deterministic first productive action — identical across modes so the
// only variable is cold vs forked orientation.
const TASK =
	'Run the command "git rev-parse HEAD" and reply with ONLY its output.';

const reading = (ok: boolean): ProbeReading => ({
	ok,
	wall_ms: null,
	input_tokens: null,
	output_tokens: null,
	cache_read: null,
	cache_creation: null,
	session_id: null,
});

// claude result-JSON parse: usage split + duration + session id. The CLI can
// append diagnostics AFTER the result object (observed live 2026-10-07:
// an [claude-code:unrecognized_model] line), so walk candidate object
// windows and accept the first that parses with a session id or usage.
export const parseClaude = (out: string): ProbeReading => {
	for (
		let start = out.indexOf("{");
		start >= 0;
		start = out.indexOf("{", start + 1)
	) {
		for (
			let end = out.lastIndexOf("}");
			end > start;
			end = out.lastIndexOf("}", end - 1)
		) {
			try {
				const r = JSON.parse(out.slice(start, end + 1)) as {
					is_error?: boolean;
					duration_ms?: number;
					duration_api_ms?: number;
					session_id?: string;
					usage?: Record<string, number>;
				};
				if (!r.session_id && !r.usage) continue;
				return {
					ok: true,
					wall_ms: r.duration_ms ?? r.duration_api_ms ?? null,
					input_tokens: r.usage?.input_tokens ?? null,
					output_tokens: r.usage?.output_tokens ?? null,
					cache_read: r.usage?.cache_read_input_tokens ?? null,
					cache_creation: r.usage?.cache_creation_input_tokens ?? null,
					session_id: r.session_id ?? null,
				};
			} catch {
				// try the next (shorter) window
			}
		}
	}
	return reading(false);
};

// codex result parse: `exec --json` JSONL events. thread.started carries the
// thread id; turn.completed carries per-turn usage, SUMMED across turns (a
// probe that runs a command burns more than one). Codex input_tokens INCLUDE
// cached_input_tokens (OpenAI semantics) — fresh = input − cached, computed
// downstream, never in the record.
export const parseCodex = (out: string): ProbeReading => {
	const r = reading(false);
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			const j = JSON.parse(t) as {
				type?: string;
				thread_id?: string;
				usage?: Record<string, number>;
			};
			applyCodexEvent(r, j);
		} catch {
			continue;
		}
	}
	return r;
};

// One codex event mutates the running ProbeReading (parseCodex helper).
const applyCodexEvent = (
	r: ProbeReading,
	j: { type?: string; thread_id?: string; usage?: Record<string, number> },
): void => {
	if (j.type === "thread.started" && typeof j.thread_id === "string") {
		r.ok = true;
		r.session_id = j.thread_id;
	}
	if (j.type === "turn.completed" && j.usage) {
		r.input_tokens = (r.input_tokens ?? 0) + (j.usage.input_tokens ?? 0);
		r.output_tokens = (r.output_tokens ?? 0) + (j.usage.output_tokens ?? 0);
		r.cache_read = (r.cache_read ?? 0) + (j.usage.cached_input_tokens ?? 0);
		r.cache_creation =
			(r.cache_creation ?? 0) + (j.usage.cache_write_input_tokens ?? 0);
	}
};

// Recipe table: verified surfaces only. copilot stays a catalog placeholder
// (parse = presence + wall clock) until its JSON usage surface verifies
// against a live binary; codex rides the verified JSONL contract.
const recipeFor = (harness: string) => {
	switch (harness) {
		case "codex":
			return {
				probeArgs: (fork: ForkLike | null): string[] => [
					"--sandbox",
					"danger-full-access",
					"exec",
					...(fork ? ["fork", fork.sessionId] : []),
					TASK,
					"--json",
				],
				parse: parseCodex,
			};
		case "claude":
			return {
				probeArgs: (fork: ForkLike | null): string[] => [
					"-p",
					TASK,
					"--output-format",
					"json",
					...(fork ? fork.forkArgs : []),
				],
				parse: parseClaude,
			};
		case "copilot":
			return {
				probeArgs: (fork: ForkLike | null): string[] => [
					"-p",
					TASK,
					"--allow-all-tools",
				],
				parse: (out: string): ProbeReading => reading(out.trim().length > 0),
			};
		default:
			return null;
	}
};

const spawnProbe = (
	bin: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
): { code: number; out: string; t0: number; pid: number | undefined } => {
	const t0 = Date.now();
	const p = Bun.spawnSync([bin, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeoutMs: TIMEOUT,
	});
	const out = `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${
		p.stderr ? new TextDecoder().decode(p.stderr) : ""
	}`;
	return { code: p.exitCode ?? 1, out, t0, p: p.pid };
};

const runOne = (
	run: number,
	mode: "cold" | "fork",
	bin: string,
	recipe: {
		probeArgs: (f: ForkLike | null) => string[];
		parse: (o: string) => ProbeReading;
	},
	fork: ForkLike | null,
	cwd: string,
	env: Record<string, string>,
): BenchRecord => {
	const spawned = spawnProbe(bin, recipe.probeArgs(fork), cwd, env);
	const parsed = recipe.parse(spawned.out);
	const wall =
		parsed.wall_ms ?? (spawned.code === 0 ? Date.now() - spawned.t0 : null);
	const base = {
		ts: Date.now(),
		phase: PHASE,
		harness: HARNESS,
		mode,
		run,
		wall_ms: wall,
		task: TASK,
	};
	if (spawned.code !== 0 || !parsed.ok) {
		const flat = spawned.out.replaceAll("\n", " ");
		const snippet = flat.slice(0, 120);
		const tail = flat.slice(-160);
		return {
			...base,
			input_tokens: null,
			output_tokens: null,
			cache_read: null,
			cache_creation: null,
			session_id: null,
			error: `exit ${spawned.code}; len ${flat.length}; head: ${snippet} … tail: ${tail}`,
		};
	}
	// parsed first, base second: a parse WITHOUT a wall reading (codex events
	// carry no duration) must not stomp the spawn-elapsed fallback.
	return { ...parsed, ...base, wall_ms: wall, error: undefined };
};

const summarize = (records: BenchRecord[]): string => {
	const good = records.filter((r) => !r.error);
	if (good.length === 0) return "no usable runs";
	const wall = good.filter((r) => r.wall_ms !== null);
	const inTok = good.filter((r) => r.input_tokens !== null);
	const cache = good.filter((r) => r.cache_read !== null);
	const mean = (xs: number[]): number =>
		xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
	const share = (xs: BenchRecord[]): number => {
		const pairs = xs
			.map((r) => [r.input_tokens, r.cache_read] as const)
			.filter(([i, c]) => i !== null && c !== null) as [number, number][];
		const totIn = pairs.reduce((a, [i]) => a + i, 0);
		const totC = pairs.reduce((a, [, c]) => a + c, 0);
		return totIn + totC === 0 ? NaN : Math.round((totC / (totIn + totC)) * 100);
	};
	return [
		`runs=${good.length}/${records.length}`,
		`wall_ms mean=${Math.round(mean(wall.map((r) => r.wall_ms as number)))}`,
		`input mean=${Math.round(mean(inTok.map((r) => r.input_tokens as number)))}`,
		`cache_read mean=${Math.round(mean(cache.map((r) => r.cache_read as number)))}`,
		`cache_read share=${share(good)}%`,
	].join(" · ");
};

if (import.meta.main) {
	const recipe = recipeFor(HARNESS);
	const bin = arg("bin") ?? process.env.SUSPENDERS_CLAUDE_BIN;
	if (!recipe || !bin) {
		console.log(`UNAVAILABLE ${HARNESS} — no recipe or no executor bin env`);
		process.exit(3);
	}
	mkdirSync(OUT, { recursive: true });
	const wantFork =
		PHASE === "post" &&
		(starterEnabledFor(process.env, HARNESS) || arg("starter") === "on");
	const starterOutcome = wantFork
		? ensureStarter(join(REPO, ".fleet"), HARNESS, bin, process.env, {
				log: (l) => console.log(`[starter] ${l}`),
			})
		: null;
	const fork =
		starterOutcome?.kind === "fork" ? starterOutcome.fork : null;
	if (starterOutcome?.kind === "failure")
		console.log(
			`[starter] seed failed (code ${starterOutcome.failure.code}, phase ${starterOutcome.failure.phase}): ${starterOutcome.failure.stderrTail}`,
		);
	const mode: "cold" | "fork" = fork ? "fork" : "cold";
	const outFile = join(OUT, `${PHASE}-${HARNESS}.ndjson`);
	if (fork)
		console.log(`fork mode: starter ${fork.version} session ${fork.sessionId}`);
	const records: BenchRecord[] = [];
	for (let run = 1; run <= RUNS; run++) {
		const rec = runOne(run, mode, bin, recipe, fork, REPO, process.env);
		records.push(rec);
		appendFileSync(outFile, `${JSON.stringify(rec)}\n`);
		console.log(JSON.stringify(rec));
	}
	console.log(summarize(records));
	if (records.length > 0 && records.every((r) => r.error)) process.exit(4);
}
