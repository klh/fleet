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
import { ensureStarter, starterEnabled } from "./lib/lane-starter.ts";

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
const TASK = 'Run the command "git rev-parse HEAD" and reply with ONLY its output.';

const outputTokens = (out: string): number | null => {
	const m = out.match(/"output_tokens":\s*(\d+)/);
	return m ? Number(m[1]) : null;
};

const reading = (ok: boolean): ProbeReading => ({
	ok,
	wall_ms: null,
	input_tokens: null,
	output_tokens: null,
	cache_read: null,
	cache_creation: null,
	session_id: null,
});

// claude result-JSON parse: usage split + duration + session id.
export const parseClaude = (out: string): ProbeReading => {
	const start = out.indexOf("{");
	if (start < 0) return reading(false);
	try {
		const r = JSON.parse(out.slice(start)) as {
			is_error?: boolean;
			duration_ms?: number;
			session_id?: string;
			usage?: Record<string, number>;
		};
		if (r.is_error) return reading(false);
		return {
			ok: Boolean(r.session_id || r.usage),
			wall_ms: r.duration_ms ?? null,
			input_tokens: r.usage?.input_tokens ?? null,
			output_tokens: r.usage?.output_tokens ?? outputTokens(out),
			cache_read: r.usage?.cache_read_input_tokens ?? null,
			cache_creation: r.usage?.cache_creation_input_tokens ?? null,
			session_id: r.session_id ?? null,
		};
	} catch {
		return reading(false);
	}
};

// Recipe table: verified surfaces only. codex/copilot rows are catalog
// placeholders (parse = presence + wall clock) until their JSON usage
// surfaces are verified against live output.
const recipeFor = (harness: string) => {
	switch (harness) {
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
	recipe: { probeArgs: (f: ForkLike | null) => string[]; parse: (o: string) => ProbeReading },
	fork: ForkLike | null,
	cwd: string,
	env: Record<string, string>,
): BenchRecord => {
	const spawned = spawnProbe(bin, recipe.probeArgs(fork), cwd, env);
	const parsed = recipe.parse(spawned.out);
	const wall = parsed.wall_ms ?? (spawned.code === 0 ? Date.now() - spawned.t0 : null);
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
		return {
			...base,
			input_tokens: null,
			output_tokens: null,
			cache_read: null,
			cache_creation: null,
			session_id: null,
			error: `exit ${spawned.code}${parsed.ok ? "" : "; result unparseable"}`,
		};
	}
	return { ...base, ...parsed, error: undefined };
};

const summarize = (records: BenchRecord[]): string => {
	const good = records.filter((r) => !r.error);
	if (good.length === 0) return "no usable runs";
	const wall = good.filter((r) => r.wall_ms !== null);
	const inTok = good.filter((r) => r.input_tokens !== null);
	const cache = good.filter((r) => r.cache_read !== null);
	const mean = (xs: number[]): number =>
		xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
	return [
		`runs=${good.length}/${records.length}`,
		`wall_ms mean=${Math.round(mean(wall.map((r) => r.wall_ms as number)))}`,
		`input mean=${Math.round(mean(inTok.map((r) => r.input_tokens as number)))}`,
		`cache_read mean input+cache_read share=${Math.round(mean(cache.map((r) => r.cache_read as number)))}`,
	].join(" · ");
};

if (import.meta.main) {
	const recipe = recipeFor(HARNESS);
	const bin = process.env.SUSPENDERS_CLAUDE_BIN;
	if (!recipe || !bin) {
		console.log(`UNAVAILABLE ${HARNESS} — no recipe or no executor bin env`);
		process.exit(3);
	}
	mkdirSync(OUT, { recursive: true });
	const wantFork = PHASE === "post" && starterEnabled(process.env);
	const fork = wantFork
		? ensureStarter(join(REPO, ".fleet"), HARNESS, bin, process.env)
		: null;
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









