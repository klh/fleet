// review-run.ts — W792: CLI for the review A/B arena. --design seals the
// task set into review-seal/ (sha16-pinned MANIFEST), --run executes both
// arms over the sealed tasks (AC-gated, ping-preflighted, resumable JSONL)
// and --report renders the decision-grade metrics table.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonl, sha } from "./core.ts";
import {
	type ArmAggregate,
	type ArmOutcome,
	aggregate,
	scoreOutcome,
} from "./review-score.ts";
import {
	ARM_A_PORT,
	type ReviewTask,
	REVIEW_DIR,
	REVIEW_LEGS,
	REVIEW_SEED,
} from "./review-core.ts";
import { armA, armB, pingLocal } from "./review-pipeline.ts";
import { assembleReviewTasks } from "./review-set.ts";
import { acGate, Refused } from "./runner.ts";

const ARENA = import.meta.dir;
const RES = join(ARENA, "results");
const SEAL = join(ARENA, REVIEW_DIR);

import { f0, f2, pct, qualLabel, sep } from "./stats.ts";
export interface Args {
	design: boolean;
	run: boolean;
	report: boolean;
	arm: "a" | "b" | "both";
	limit: number;
	src?: string;
	runId: string | null;
}
export function parseArgs(argv: string[]): Args {
	const a: Args = { design: false, run: false, report: false, arm: "both", limit: 0, runId: null };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i] ?? "";
		const nx = argv[i + 1];
		if (k === "--design") a.design = true;
		else if (k === "--run") a.run = true;
		else if (k === "--report") a.report = true;
		else if (k === "--arm" && nx) {
			a.arm = nx as Args["arm"];
			i++;
		} else if (k === "--limit" && nx) {
			a.limit = Number(nx);
			i++;
		} else if (k === "--src" && nx) {
			a.src = nx;
			i++;
		} else if (k === "--run-id" && nx) {
			a.runId = nx;
			i++;
		} else throw new Error(`unknown arg ${k}`);
	}
	return a;
}
/** Seal the assembled task set into review-seal/ (refuses to overwrite). */
export function design(): { hash: string; count: number } {
	if (existsSync(SEAL)) throw new Refused(`seal exists: ${SEAL}`, 3);
	const tasks = assembleReviewTasks();
	mkdirSync(SEAL, { recursive: true });
	const body = `${JSON.stringify(tasks)}\n`;
	writeFileSync(join(SEAL, "tasks.json"), body);
	const manifest = {
		hash: sha(body).slice(0, 16),
		count: tasks.length,
		generators: "review-set.ts",
		seed: REVIEW_SEED,
	};
	writeFileSync(join(SEAL, "MANIFEST.json"), `${JSON.stringify(manifest)}\n`);
	return { hash: manifest.hash, count: tasks.length };
}
/** Load the sealed set, verifying the MANIFEST hash. */
export async function loadSeal(): Promise<ReviewTask[]> {
	const body = readFileSync(join(SEAL, "tasks.json"), "utf8");
	const man = JSON.parse(readFileSync(join(SEAL, "MANIFEST.json"), "utf8")) as {
		hash: string;
	};
	if (sha(body).slice(0, 16) !== man.hash)
		throw new Refused(`seal hash mismatch: ${SEAL}/tasks.json`, 3);
	return JSON.parse(body) as ReviewTask[];
}
const rowFile = (runId: string, arm: "a" | "b"): string =>
	join(RES, `rev-${runId}-${arm}.jsonl`);
/** Run one arm over the tasks — resumable JSONL, 2 workers. */
export async function runArm(
	tasks: ReviewTask[],
	arm: "a" | "b",
	runId: string,
	limit: number,
): Promise<number> {
	mkdirSync(RES, { recursive: true });
	const file = rowFile(runId, arm);
	const done = new Set<string>();
	for await (const r of jsonl<{ taskId: string; runOk: boolean }>(file)) {
		if (r.runOk) done.add(r.taskId);
	}
	const todo = tasks.filter((t) => !done.has(t.id));
	if (limit > 0) todo.splice(limit);
	const worker = async (): Promise<void> => {
		while (todo.length > 0) {
			const t = todo.shift();
			if (!t) break;
			const run = arm === "a" ? await armA(t) : await armB(t);
			const out = scoreOutcome({
				arm,
				taskId: t.id,
				src: t.src,
				defects: t.defects,
				findings: run.findings,
				roundsToPass: run.roundsToPass,
				verdict: run.verdict,
				tokIn: run.tokIn,
				tokOut: run.tokOut,
				calls: run.calls,
				wallMs: run.wallMs,
			});
			appendFileSync(file, `${JSON.stringify({ ...out, runOk: run.ok, err: run.err })}\n`);
			console.log(
				`${arm}/${t.id} ${run.verdict} r${run.roundsToPass} in${out.tokIn} ok=${run.ok}${run.err ? ` ${run.err}` : ""}`,
			);
		}
	}
	await Promise.all([worker(), worker()]);
	return todo.length;
}
/** Run the arms over the sealed set (AC-gated, ping-preflighted). */
export async function run(
	runId: string,
	armSel: "a" | "b" | "both",
	limit: number,
	src?: string,
): Promise<void> {
	acGate();
	const tasks = await loadSeal();
	const picked = src ? tasks.filter((t) => t.src === src) : tasks;
	const ports = [
		...new Set([
			ARM_A_PORT,
			...Object.values(REVIEW_LEGS).map((l) => l.port),
		]),
	];
	for (const p of ports) {
		if (!(await pingLocal(p)))
			throw new Refused(
				`leg port ${p} not answering — re-point REVIEW_*_PORT or load the tier`,
				3,
			);
	}
	const arms: Array<"a" | "b"> = armSel === "both" ? ["a", "b"] : [armSel];
	for (const arm of arms) await runArm(picked, arm, runId, limit);
}
/** Render the decision-grade metrics table from the result JSONLs. */
export async function report(runId: string): Promise<string> {
	const lines: string[] = [`# W792 review arena — run ${runId}`, ""];
	const outs: Record<"a" | "b", ArmOutcome[]> = { a: [], b: [] };
	for (const arm of ["a", "b"] as const) {
		for await (const r of jsonl<ArmOutcome>(rowFile(runId, arm)))
			outs[arm].push(r);
	}
	if (!outs.a.length && !outs.b.length)
		throw new Refused(`no results for run ${runId} — nothing to report`, 1);
	const aggs: ArmAggregate[] = ["a", "b"]
		.filter((arm) => outs[arm].length > 0)
		.map((arm) => aggregate(arm, outs[arm]));
	lines.push(
		`| metric | ${aggs.map((g) => `arm ${g.arm.toUpperCase()} (n=${g.n}, ${qualLabel(g.n)})`).join(" | ")} |`,
		sep(1 + aggs.length),
	);
	const L = (
		label: string,
		pick: (g: ArmAggregate) => string | number,
	): void => {
		lines.push(`| ${label} | ${aggs.map(pick).join(" | ")} |`);
	};
	L("recall (seeded)", (g) => pct(g.recall));
	L("file recall", (g) => pct(g.fileRecall));
	L("false positives / task", (g) => f2(g.meanFpPerTask));
	L("human-required / task", (g) => f2(g.humanRequiredPerTask));
	L("human noise / clean task", (g) => f2(g.humanNoisePerCleanTask));
	L("converged ≤3 rounds", (g) => `${g.converged}/${g.n}`);
	L("median rounds", (g) => f0(g.medianRounds));
	L("verdict accuracy", (g) => pct(g.verdictAccuracy));
	L("tok-in p50", (g) => f0(g.tokInP50));
	L("tok-out p50", (g) => f0(g.tokOutP50));
	L("calls p50", (g) => f0(g.callsP50));
	L("wall p50 (s)", (g) => f2((g.wallP50 ?? 0) / 1000));
	lines.push("");
	lines.push(
		"Honesty: quality labels from stats.qualLabel by n; arm B triage rides",
		"the extract tier (kev :8912 speaks its SystemOne wire, not the openai",
		"chat wire the arena legs share) and the fixer leg rides",
		"REVIEW_FIXER_PORT as env-re-pointed. Per-task rows + call traces live",
		"in results/rev-<runId>-<arm>.jsonl.",
	);
	return lines.join("\n");
}
async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	let runId = a.runId;
	if (a.design) {
		const d = design();
		console.log(`sealed ${d.count} tasks @ ${REVIEW_DIR} (sha16 ${d.hash})`);
	}
	if (a.run) {
		if (!runId)
			runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		await run(runId, a.arm, a.limit, a.src);
	}
	if (a.report) {
		if (!runId) throw new Refused("--report needs --run-id <id>", 1);
		const md = await report(runId);
		console.log(md);
	}
	if (!a.design && !a.run && !a.report)
		throw new Refused("nothing to do — pass --design / --run / --report", 1);
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = e instanceof Refused ? e.code : 1;
}
