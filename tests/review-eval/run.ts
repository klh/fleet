// tests/review-eval/run.ts — W1172 matched before/after review-agent runner.
//
// Laws this CLI encodes:
// - DEFER GATE: `--run` refuses unless W1172_GATE=open — the item's own law
//   (no matched agent batches until the W1124 productive 30-40 verification
//   receipt exists). `--plan` always runs and spawns nothing.
// - NO SELF-MINTED CLAIMS: the runner reports found/false-positive/token
//   totals and mints NO improvement claim; usage counts and regex output
//   scans are not evidence of review quality (W1144 law).
// - PRIVATE JUDGE: scoring happens only through the machine-local rubric
//   file; no rubric, no run.
//
// Modes:
//   bun tests/review-eval/run.ts --plan  [flags]   validate pins, no agents
//   bun tests/review-eval/run.ts --run   [flags]   gated matched batches
//
// Flags: --inventory <file> --judge-prompt <file> --settings <file>
//        --out <dir> --tasks t1,t2 --before <rev> --after <rev>
//        --judge-url <url>   (env: W1172_JUDGE_KEY, W1172_JUDGE_MODEL)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	emptyTotals,
	sha256,
	type ArmReceipt,
	type Manifest,
	type RunRecord,
} from "./receipt.ts";
import { TASKS, corpusSha, taskById, type ReviewTask } from "./corpus.ts";
import {
	loadInventory,
	validateInventory,
	type Inventory,
} from "./inventory.ts";
import { judgeOutput } from "./judge.ts";
import {
	buildExecutorArgv,
	buildSystemPrompt,
	buildTaskPrompt,
	parseClaudeEnvelope,
	spawnClaude,
} from "./executor.ts";

export type ArmBundle = {
	arm: ArmReceipt;
	content: string;
};

/** Resolve one skill arm from git history (byte-exact, sha-pinned). */
export function resolveArm(rev: string, skillPath: string): ArmBundle {
	const revParse = Bun.spawnSync(["git", "rev-parse", rev], {
		cwd: REPO_ROOT,
	});
	const commit = revParse.stdout.toString().trim();
	if (revParse.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error(`cannot resolve commit for ${rev}`);
	}
	const show = Bun.spawnSync(["git", "show", `${rev}:${skillPath}`], {
		cwd: REPO_ROOT,
	});
	const content = show.stdout.toString();
	if (show.exitCode !== 0 || content.trim() === "") {
		throw new Error(`cannot resolve skill at ${rev}:${skillPath}`);
	}
	return {
		arm: {
			rev,
			commit,
			skillPath,
			skillSha256: sha256(content),
		},
		content,
	};
}

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const DEFAULT_BEFORE_REV = "b0cd7fb6";
export const DEFAULT_AFTER_REV = "HEAD";
export const DEFAULT_OUT_DIR = join(
	homedir(),
	".claude/local-llm/blam/w1172/runs",
);

export type SpawnResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

export type RunnerDeps = {
	spawnExecutor?: (
		cmd: string[],
		env: Record<string, string>,
	) => Promise<SpawnResult>;
};

export type ParsedArgs = {
	mode: "plan" | "run";
	inventory: string;
	judgePrompt: string;
	settings: string;
	out: string;
	tasks: string[];
	before: string;
	after: string;
	judgeUrl: string;
};

function defaultArgs(): ParsedArgs {
	return {
		mode: "plan",
		inventory: join(homedir(), ".claude/local-llm/blam/w1172/inventory.json"),
		judgePrompt: join(
			homedir(),
			".claude/local-llm/blam/w1172/judge-prompt.md",
		),
		settings: join(
			homedir(),
			".claude/local-llm/blam/w1172/executor-settings.json",
		),
		out: DEFAULT_OUT_DIR,
		tasks: [],
		before: DEFAULT_BEFORE_REV,
		after: DEFAULT_AFTER_REV,
		judgeUrl: "http://127.0.0.1:8903/v1/chat/completions",
	};
}

export function parseArgs(argv: string[]): ParsedArgs {
	return finishArgs(argv, defaultArgs());
}

function finishArgs(argv: string[], args: ParsedArgs): ParsedArgs {
	const val = (i: number): string => {
		const v = argv[i + 1];
		if (v === undefined) throw new Error(`missing value after ${argv[i]}`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--run") args.mode = "run";
		else if (a === "--plan") args.mode = "plan";
		else if (a === "--inventory") args.inventory = val(i++);
		else if (a === "--judge-prompt") args.judgePrompt = val(i++);
		else if (a === "--settings") args.settings = val(i++);
		else if (a === "--out") args.out = val(i++);
		else if (a === "--tasks") args.tasks = val(i++).split(",");
		else if (a === "--before") args.before = val(i++);
		else if (a === "--after") args.after = val(i++);
		else if (a === "--judge-url") args.judgeUrl = val(i++);
		else throw new Error(`unknown argument: ${a}`);
	}
	return args;
}

export const SKILL_PATH = "skills/review/SKILL.md";

/** The defer gate: matched batches only when the operator opens it. */
export function gateOpen(): boolean {
	return process.env.W1172_GATE === "open";
}

const msg = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

/** Tasks selected by --tasks (default: the whole corpus). */
export function selectTasks(args: ParsedArgs): ReviewTask[] {
	if (args.tasks.length === 0) return [...TASKS];
	const out: ReviewTask[] = [];
	for (const id of args.tasks) {
		const t = taskById(id);
		if (t === undefined) throw new Error(`unknown task id: ${id}`);
		out.push(t);
	}
	return out;
}

export type PlanState = {
	ok: boolean;
	problems: string[];
	tasks: string[];
};

const FILE_PINS: {
	label: string;
	key: "inventory" | "judgePrompt" | "settings";
}[] = [
	{ label: "inventory", key: "inventory" },
	{ label: "judge-prompt", key: "judgePrompt" },
	{ label: "executor-settings", key: "settings" },
];

function checkFilePins(args: ParsedArgs, problems: string[]): void {
	for (const { label, key } of FILE_PINS) {
		if (!existsSync(args[key])) {
			problems.push(`${label} missing: ${args[key]}`);
		}
	}
}

function checkInventory(
	args: ParsedArgs,
	tasks: ReviewTask[],
	problems: string[],
): void {
	if (!existsSync(args.inventory)) return;
	try {
		const inv = loadInventory(args.inventory);
		problems.push(...validateInventory(tasks, inv));
	} catch (e) {
		problems.push(`inventory unreadable: ${msg(e)}`);
	}
}

function checkArms(args: ParsedArgs, problems: string[]): void {
	for (const which of ["before", "after"] as const) {
		try {
			resolveArm(args[which], SKILL_PATH);
		} catch (e) {
			problems.push(`${which} arm unresolvable at ${args[which]}: ${msg(e)}`);
		}
	}
}

/** Zero-load pin validation: files, inventory fit, arm revs, judge env. */
export function planState(
	args: ParsedArgs,
	tasks: ReviewTask[] = selectTasks(args),
): PlanState {
	const problems: string[] = [];
	checkFilePins(args, problems);
	checkInventory(args, tasks, problems);
	checkArms(args, problems);
	if (!process.env.W1172_JUDGE_KEY) {
		problems.push("W1172_JUDGE_KEY missing/empty");
	}
	if (!process.env.W1172_JUDGE_MODEL) {
		problems.push("W1172_JUDGE_MODEL missing/empty");
	}
	return { ok: problems.length === 0, problems, tasks: tasks.map((t) => t.id) };
}

function newManifest(
	args: ParsedArgs,
	judgeModel: string,
	corpus: ReviewTask[],
): Manifest {
	const emptyArm = (): ArmReceipt => ({
		rev: "",
		commit: "",
		skillPath: SKILL_PATH,
		skillSha256: "",
	});
	return {
		runId: randomUUID(),
		ts: new Date().toISOString(),
		gate: "W1172_GATE=open",
		corpusSha: corpusSha(corpus),
		taskIds: corpus.map((t) => t.id),
		arms: { before: emptyArm(), after: emptyArm() },
		pins: {
			executor: "claude -p --output-format json",
			settingsPath: args.settings,
			judge: { url: args.judgeUrl, model: judgeModel },
		},
		runs: [],
		totals: emptyTotals(),
	};
}

type RunCtx = {
	args: ParsedArgs;
	task: ReviewTask;
	which: "before" | "after";
	system: string;
	judgeKey: string;
	judgeModel: string;
	judgePrompt: string;
	inv: Inventory;
	spawnExecutor: (
		cmd: string[],
		env: Record<string, string>,
	) => Promise<SpawnResult>;
};

/** One matched cell: spawn the executor, parse the envelope, judge once. */
async function runOne(ctx: RunCtx): Promise<RunRecord> {
	const t0 = Date.now();
	const spawned = await ctx.spawnExecutor(
		buildExecutorArgv({
			settingsPath: ctx.args.settings,
			system: ctx.system,
			prompt: buildTaskPrompt(ctx.task),
		}),
		{},
	);
	const envelope = parseClaudeEnvelope(spawned.stdout);
	const record: RunRecord = {
		task: ctx.task.id,
		arm: ctx.which,
		exitCode: spawned.exitCode,
		durationMs: Date.now() - t0,
		output: envelope?.result ?? `unparsed: ${spawned.stdout.slice(0, 2000)}`,
		usage: envelope?.usage ?? { input: 0, output: 0, cacheRead: 0 },
		costUsd: envelope?.costUsd ?? null,
		score: null,
	};
	if (envelope !== null) {
		const judged = await judgeOutput({
			url: ctx.args.judgeUrl,
			key: ctx.judgeKey,
			model: ctx.judgeModel,
			prompt: ctx.judgePrompt,
			ask: ctx.task.ask,
			fileName: ctx.task.name,
			fileContent: ctx.task.content,
			reviewOutput: record.output,
		});
		record.score = judged.score;
	}
	return record;
}

/** Roll per-run records into the per-arm totals (found/planted/FP/tokens). */
function addTotals(manifest: Manifest, inv: Inventory): void {
	for (const run of manifest.runs) {
		const tot = manifest.totals[run.arm];
		tot.inputTokens += run.usage.input;
		tot.outputTokens += run.usage.output;
		tot.cacheReadTokens += run.usage.cacheRead;
		if (run.costUsd !== null) {
			tot.costUsd = (tot.costUsd ?? 0) + run.costUsd;
		}
		tot.planted += inv.tasks[run.task]?.length ?? 0;
		if (run.score !== null) {
			tot.found += run.score.perIssue.filter((i) => i.found).length;
			tot.falsePositives += run.score.falsePositives;
		}
	}
}

/** Write the 0600 receipt manifest under a 0700 out dir. */
function writeManifest(args: ParsedArgs, manifest: Manifest): string {
	mkdirSync(args.out, { recursive: true, mode: 0o700 });
	const path = join(args.out, `${manifest.runId}.json`);
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`, {
		mode: 0o600,
	});
	return path;
}

function defaultSpawnExecutor(
	cmd: string[],
	env: Record<string, string>,
): Promise<SpawnResult> {
	return spawnClaude({
		argv: cmd,
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
	});
}

type JudgeEnv = {
	judgeKey: string;
	judgeModel: string;
	judgePrompt: string;
	inv: Inventory;
};

/** One whole arm: resolve the skill, then run every corpus task. */
async function runArm(
	args: ParsedArgs,
	which: "before" | "after",
	corpus: ReviewTask[],
	env: JudgeEnv,
	spawnExecutor: (
		cmd: string[],
		env: Record<string, string>,
	) => Promise<SpawnResult>,
	manifest: Manifest,
): Promise<void> {
	const bundle = resolveArm(args[which], SKILL_PATH);
	manifest.arms[which] = bundle.arm;
	const system = buildSystemPrompt(bundle.content);
	for (const task of corpus) {
		manifest.runs.push(
			await runOne({
				args,
				task,
				which,
				system,
				judgeKey: env.judgeKey,
				judgeModel: env.judgeModel,
				judgePrompt: env.judgePrompt,
				inv: env.inv,
				spawnExecutor,
			}),
		);
	}
}

/** Matched before/after batches: spawn → parse → judge → 0600 receipt. */
export async function runMode(
	args: ParsedArgs,
	deps: RunnerDeps = {},
	corpus: ReviewTask[] = selectTasks(args),
): Promise<Manifest> {
	if (!gateOpen()) {
		throw new Error("W1172 gate SHUT: batches wait for W1172_GATE=open.");
	}
	const plan = planState(args, corpus);
	if (!plan.ok) {
		throw new Error(`plan invalid: ${plan.problems.join("; ")}`);
	}
	const env: JudgeEnv = {
		judgeKey: process.env.W1172_JUDGE_KEY ?? "",
		judgeModel: process.env.W1172_JUDGE_MODEL ?? "",
		judgePrompt: readFileSync(args.judgePrompt, "utf8"),
		inv: loadInventory(args.inventory),
	};
	const spawnExecutor = deps.spawnExecutor ?? defaultSpawnExecutor;
	const manifest = newManifest(args, env.judgeModel, corpus);
	await runArm(args, "before", corpus, env, spawnExecutor, manifest);
	await runArm(args, "after", corpus, env, spawnExecutor, manifest);
	addTotals(manifest, env.inv);
	writeManifest(args, manifest);
	return manifest;
}

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.mode === "plan") {
		const state = planState(args);
		console.log(JSON.stringify({ ...state, corpusSha: corpusSha() }, null, 2));
		return state.ok ? 0 : 1;
	}
	if (!gateOpen()) {
		console.error(
			"W1172 gate SHUT: matched agent batches are deferred until the " +
				"operator opens W1172_GATE (W1124 rollout verification first).",
		);
		return 2;
	}
	const manifest = await runMode(args);
	console.log(
		JSON.stringify(
			{
				runId: manifest.runId,
				manifestPath: join(args.out, `${manifest.runId}.json`),
				totals: manifest.totals,
			},
			null,
			2,
		),
	);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : e);
		process.exitCode = 1;
	});
}
