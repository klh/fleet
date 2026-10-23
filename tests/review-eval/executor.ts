// tests/review-eval/executor.ts — the headless review-agent executor leg.
// Both arms ride the identical W960 recipe: `claude -p --output-format json`
// with the arm's skill text appended to the system prompt plus a bench
// contract that forbids tools/network/commits. The arm skill is the ONLY
// variable between arms; ask, file, model pin and settings pin are matched.
import type { ReviewTask } from "./corpus.ts";
import type { Usage } from "./receipt.ts";

export const BENCH_CONTRACT =
	"Bench contract: this is a single-shot read-only review of the file " +
	"provided in the task prompt. Do not run shell commands or tools, do " +
	"not commit, do not call coordination CLIs, do not fetch the network. " +
	"Reply with the review text only.";

export function buildTaskPrompt(task: ReviewTask): string {
	return [
		task.ask,
		"",
		`File under review — ${task.name}`,
		"",
		task.content,
	].join("\n");
}

export function buildSystemPrompt(skillContent: string): string {
	return `${skillContent.trim()}\n\n${BENCH_CONTRACT}`;
}

/** The W960 claude-p recipe: JSON envelope, pinned settings, skill as system. */
export function buildExecutorArgv(opts: {
	settingsPath: string;
	system: string;
	prompt: string;
}): string[] {
	return [
		"claude",
		"-p",
		"--output-format",
		"json",
		"--settings",
		opts.settingsPath,
		"--append-system-prompt",
		opts.system,
		opts.prompt,
	];
}

export type ClaudeEnvelope = {
	result: string | null;
	usage: Usage;
	costUsd: number | null;
	isError: boolean;
};

/** Parse the `claude -p --output-format json` envelope; null when not JSON. */
export function parseClaudeEnvelope(raw: string): ClaudeEnvelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as Record<string, unknown>;
	const usage = (
		typeof o.usage === "object" && o.usage !== null ? o.usage : {}
	) as Record<string, unknown>;
	const num = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) ? v : 0;
	return {
		result: typeof o.result === "string" ? o.result : null,
		usage: {
			input: num(usage.input_tokens),
			output: num(usage.output_tokens),
			cacheRead: num(usage.cache_read_input_tokens),
		},
		costUsd:
			typeof o.total_cost_usd === "number" && Number.isFinite(o.total_cost_usd)
				? o.total_cost_usd
				: null,
		isError: o.is_error === true,
	};
}

/** Async spawn with piped capture; argv-only (spawnSync ignores fed stdin). */
export async function spawnClaude(opts: {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
}): Promise<{
	exitCode: number | null;
	stdout: string;
	stderr: string;
}> {
	const proc = Bun.spawn(opts.argv, {
		cwd: opts.cwd,
		env: opts.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode: await proc.exited, stdout, stderr };
}
