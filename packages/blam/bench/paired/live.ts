// Live paired harness evaluation. Each arm starts from the same Git revision
// in a disposable worktree; only the harness text differs in the prompt.
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gatePromotion } from "../../src/promotion.ts";
import { pairedLift, type PairedRep } from "./types.ts";

export interface LiveManifest {
	repo: string;
	baseRef: string;
	task: string;
	model: string;
	baseline: string;
	candidate: string;
	reps: number;
	/** Identical argv for both arms; {prompt}, {worktree}, {model} expand. */
	executor: string[];
	/** Held outside both worktrees. Exit 0 means the resulting artifact passes. */
	judge: string[];
	timeoutMs: number;
	outputDir: string;
}

export interface ArmReceipt {
	arm: "baseline" | "candidate";
	rep: number;
	laneId: string;
	baseSha: string;
	harnessSha256: string;
	model: string;
	executorExit: number;
	judgeExit: number | null;
	timedOut: boolean;
	tokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	quality: number;
	wallMs: number;
	judgeMs: number | null;
	outputSha256: string;
	patchFile: string;
}

export interface LiveReport {
	manifestSha256: string;
	baseSha: string;
	receipts: ArmReceipt[];
	failures: { baseline: number; candidate: number };
	pairs: PairedRep[];
	lift: ReturnType<typeof pairedLift> | null;
	promotion: ReturnType<typeof gatePromotion>;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function gitRaw(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(
			`git ${args[0]} failed: ${new TextDecoder().decode(p.stderr).slice(0, 300)}`,
		);
	return new TextDecoder().decode(p.stdout);
}

export const git = (cwd: string, ...args: string[]): string =>
	gitRaw(cwd, ...args).trim();

function expanded(argv: string[], vars: Record<string, string>): string[] {
	return argv.map((part) =>
		part.replace(
			/\{(prompt|worktree|model)\}/g,
			(_, key: string) => vars[key] ?? "",
		),
	);
}

async function boundedText(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		if (text.length > 1_000_000) text = text.slice(-1_000_000);
	}
	return text + decoder.decode();
}

export async function command(
	argv: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string>,
): Promise<{ exit: number; timedOut: boolean; stdout: string }> {
	const proc = Bun.spawn(argv, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const [exit, stdout] = await Promise.all([
			proc.exited,
			boundedText(proc.stdout),
			boundedText(proc.stderr),
		]);
		return { exit, timedOut, stdout };
	} finally {
		clearTimeout(timer);
	}
}

/** Accept Claude JSON, Codex JSONL turn.completed, or a generic usage object. */
export function usageFromOutput(output: string): {
	tokens: number;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
} | null {
	const lines = output.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		let item: Record<string, unknown>;
		try {
			item = JSON.parse(lines[i]) as Record<string, unknown>;
		} catch {
			continue;
		}
		const nested =
			item.type === "turn.completed"
				? (item as { usage?: unknown }).usage
				: null;
		const usage = (item.usage ?? nested) as Record<string, unknown> | null;
		if (!usage) continue;
		const read = usage.cache_read_input_tokens ?? usage.cached_input_tokens;
		const write =
			usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens;
		const cacheReadTokens = typeof read === "number" && read >= 0 ? read : null;
		const cacheWriteTokens =
			typeof write === "number" && write >= 0 ? write : null;
		const total = usage.total_tokens;
		if (typeof total === "number" && Number.isFinite(total) && total > 0)
			return { tokens: total, cacheReadTokens, cacheWriteTokens };
		const input = usage.input_tokens;
		const outputTokens = usage.output_tokens;
		if (typeof input === "number" && typeof outputTokens === "number") {
			const tokens =
				input + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
			if (tokens <= 0) continue;
			return {
				tokens,
				cacheReadTokens,
				cacheWriteTokens,
			};
		}
	}
	return null;
}

export const tokensFromOutput = (output: string): number | null =>
	usageFromOutput(output)?.tokens ?? null;

function qualityFromJudge(output: string, exit: number): number {
	try {
		const score = (JSON.parse(output.trim()) as { score?: unknown }).score;
		if (
			typeof score === "number" &&
			Number.isFinite(score) &&
			score >= 0 &&
			score <= 1
		)
			return score;
	} catch {
		// A conventional exit-only judge still scores pass/fail.
	}
	return exit === 0 ? 1 : 0;
}

export function validateManifest(m: LiveManifest): void {
	if (
		!m.repo ||
		!m.baseRef ||
		!m.task ||
		!m.model ||
		!m.candidate ||
		!m.baseline
	)
		throw new Error(
			"repo, baseRef, task, model and both harnesses are required",
		);
	if (!Number.isInteger(m.reps) || m.reps < 1 || m.reps > 10)
		throw new Error("reps must be an integer from 1 to 10");
	if (
		!Number.isInteger(m.timeoutMs) ||
		m.timeoutMs < 1000 ||
		m.timeoutMs > 600_000
	)
		throw new Error("timeoutMs must be 1000..600000");
	if (
		!Array.isArray(m.executor) ||
		!Array.isArray(m.judge) ||
		m.executor.length === 0 ||
		m.judge.length === 0
	)
		throw new Error("executor and judge must be nonempty argv arrays");
	if (!m.executor.some((arg) => arg.includes("{prompt}")))
		throw new Error("executor must consume {prompt}");
	if (m.executor.some((arg) => arg.includes("{arm}") || arg.includes("{rep}")))
		throw new Error("executor arguments must be identical across arms");
	if (m.judge.some((arg) => arg.includes("{prompt}")))
		throw new Error("judge must not receive the harness prompt");
	const output = resolve(m.outputDir);
	const repo = resolve(m.repo);
	if (output === repo || output.startsWith(`${repo}/`))
		throw new Error("outputDir must be outside the evaluated repository");
}

async function runArm(
	m: LiveManifest,
	baseSha: string,
	rep: number,
	arm: ArmReceipt["arm"],
): Promise<ArmReceipt> {
	const laneId = `blam-${randomUUID().slice(0, 12)}`;
	const worktree = mkdtempSync(join(tmpdir(), `blam-${arm}-${rep}-`));
	const harness = arm === "baseline" ? m.baseline : m.candidate;
	const prompt = `${m.task}\n\nHarness guidance:\n${harness}`;
	let attached = false;
	try {
		git(m.repo, "worktree", "add", "--detach", worktree, baseSha);
		attached = true;
		const vars = { prompt, worktree, model: m.model };
		const started = performance.now();
		const execution = await command(
			expanded(m.executor, vars),
			worktree,
			m.timeoutMs,
			{ BLAM_LANE_ID: laneId },
		);
		const wallMs = Math.round(performance.now() - started);
		// Freeze the agent artifact before validation; the judge may create files.
		git(worktree, "add", "-N", ".");
		const patch = gitRaw(worktree, "diff", "--binary", "HEAD");
		const patchFile = join(m.outputDir, `${rep}-${arm}.patch`);
		writeFileSync(patchFile, patch, { mode: 0o600 });
		const judgeStarted = performance.now();
		const judge =
			execution.exit === 0 && !execution.timedOut
				? await command(expanded(m.judge, vars), worktree, m.timeoutMs, {
						BLAM_LANE_ID: laneId,
					})
				: null;
		const judgeMs = judge ? Math.round(performance.now() - judgeStarted) : null;
		const usage = usageFromOutput(execution.stdout);
		return {
			arm,
			rep,
			laneId,
			baseSha,
			harnessSha256: sha(harness),
			model: m.model,
			executorExit: execution.exit,
			judgeExit: judge?.exit ?? null,
			timedOut: execution.timedOut || (judge?.timedOut ?? false),
			tokens: usage?.tokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheWriteTokens: usage?.cacheWriteTokens ?? null,
			quality: judge ? qualityFromJudge(judge.stdout, judge.exit) : 0,
			wallMs,
			judgeMs,
			outputSha256: sha(execution.stdout),
			patchFile,
		};
	} finally {
		if (attached) git(m.repo, "worktree", "remove", "--force", worktree);
		rmSync(worktree, { recursive: true, force: true });
	}
}

export async function runLivePaired(
	manifest: LiveManifest,
): Promise<LiveReport> {
	validateManifest(manifest);
	const m = {
		...manifest,
		repo: resolve(manifest.repo),
		outputDir: resolve(manifest.outputDir),
	};
	const baseSha = git(m.repo, "rev-parse", `${m.baseRef}^{commit}`);
	mkdirSync(m.outputDir, { recursive: true, mode: 0o700 });
	const receipts: ArmReceipt[] = [];
	for (let rep = 0; rep < m.reps; rep++) {
		// Sequential arms avoid a local model's load/concurrency skew. The
		// alternating order balances warm-cache and first-run effects.
		const order: ArmReceipt["arm"][] =
			rep % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
		for (const arm of order) receipts.push(await runArm(m, baseSha, rep, arm));
	}
	const pairs: PairedRep[] = [];
	for (let rep = 0; rep < m.reps; rep++) {
		const baseline = receipts.find(
			(r) => r.rep === rep && r.arm === "baseline",
		);
		const candidate = receipts.find(
			(r) => r.rep === rep && r.arm === "candidate",
		);
		if (!baseline || !candidate) throw new Error(`missing arm for rep ${rep}`);
		if (baseline.tokens !== null && candidate.tokens !== null) {
			pairs.push({
				rep,
				setup: baseSha,
				off: {
					correct: baseline.quality,
					tokens: baseline.tokens,
					minutes: baseline.wallMs / 60_000,
				},
				on: {
					correct: candidate.quality,
					tokens: candidate.tokens,
					minutes: candidate.wallMs / 60_000,
				},
			});
		}
	}
	const complete =
		pairs.length === m.reps &&
		receipts.every(
			(r) => !r.timedOut && r.executorExit === 0 && r.judgeExit !== null,
		);
	const lift = complete ? pairedLift(pairs) : null;
	const failures = {
		baseline: receipts.filter((r) => r.arm === "baseline" && r.judgeExit !== 0)
			.length,
		candidate: receipts.filter(
			(r) => r.arm === "candidate" && r.judgeExit !== 0,
		).length,
	};
	const candidatePasses = receipts.every(
		(r) => r.arm !== "candidate" || r.judgeExit === 0,
	);
	const promotion = !complete
		? {
				promote: false,
				why: "missing usage, timeout, or failed executor/judge setup",
			}
		: !candidatePasses
			? {
					promote: false,
					why: "candidate failed the private validation in at least one repetition",
				}
			: gatePromotion(lift as NonNullable<typeof lift>);
	const report = {
		manifestSha256: sha(JSON.stringify(m)),
		baseSha,
		receipts,
		failures,
		pairs,
		lift,
		promotion,
	};
	writeFileSync(
		join(m.outputDir, "report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return report;
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) throw new Error("usage: bun bench/paired/live.ts <manifest.json>");
	const manifest = JSON.parse(readFileSync(path, "utf8")) as LiveManifest;
	const report = await runLivePaired(manifest);
	console.log(
		JSON.stringify(
			{
				baseSha: report.baseSha,
				reps: report.pairs.length,
				lift: report.lift,
				promotion: report.promotion,
				report: join(resolve(manifest.outputDir), "report.json"),
			},
			null,
			2,
		),
	);
}
