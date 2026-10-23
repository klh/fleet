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
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256, type ArmReceipt } from "./receipt.ts";

export type ArmBundle = {
	arm: ArmReceipt;
	content: string;
};

/** Resolve one skill arm from git history (byte-exact, sha-pinned). */
export function resolveArm(rev: string, skillPath: string): ArmBundle {
	const commit = Bun.spawnSync(["git", "rev-parse", rev], {
		cwd: REPO_ROOT,
	}).stdout.toString().trim();
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

export type InventoryIssue = {
	id: string;
	issueClass: string;
	file: string;
	line: number;
	severity: string;
};

export type Inventory = {
	tasks: Record<string, InventoryIssue[]>;
};

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
