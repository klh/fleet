// review-run.ts — W792: CLI for the review A/B arena. --design seals the
// task set into review-seal/ (sha16-pinned MANIFEST), --run executes the
// arms over the sealed tasks (AC-gated, ping-preflighted, resumable JSONL)
// and --report renders the decision-grade metrics table. W1476 (b):
// --rescore reruns each arm whose reviewer surface changed (review-surface
// .json paths, the review model pin, the sealed set) over the whole set and
// ledgers the score delta (review-rescore.ts); --rescore-status says which
// arms are due and why, without an LLM call.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha } from "./core.ts";
import { type ArmAggregate, type ArmId, aggregate } from "./review-score.ts";
import { REVIEW_DIR, REVIEW_SEED } from "./review-core.ts";
import { armLegs } from "./review-arms.ts";
import { INCIDENTS } from "./review-incident.ts";
import { ARM_IDS, loadSurface, readSeal } from "./review-rescore.ts";
import {
	type ArmLeg,
	armRows,
	rescore,
	rescoreStatus,
	runArm,
	share,
} from "./review-rescore-run.ts";
import { assembleReviewTasks } from "./review-set.ts";
import { acGate, Refused } from "./runner.ts";

const ARENA = import.meta.dir;
const ROOT = join(ARENA, "../../../..");
const RES = process.env.REVIEW_RESULTS_DIR || join(ARENA, "results");
const SEAL = process.env.REVIEW_SEAL_DIR || join(ARENA, REVIEW_DIR);
const SURFACE = join(ARENA, "review-surface.json");

import { f0, f2, qualLabel, sep } from "./stats.ts";
/** both = arms A + B (the W792 default); all = A + B + the review lane */
export type ArmSel = ArmId | "both" | "all";
const ARM_SELS: readonly ArmSel[] = [...ARM_IDS, "both", "all"];
const armsOf = (sel: ArmSel): ArmId[] =>
	sel === "both" ? ["a", "b"] : sel === "all" ? [...ARM_IDS] : [sel];
export interface Args {
	design: boolean;
	run: boolean;
	report: boolean;
	rescore: boolean;
	rescoreStatus: boolean;
	force: boolean;
	reason: string | null;
	/** null = the verb's default (--run: both, --rescore*: all) */
	arm: ArmSel | null;
	limit: number;
	src?: string;
	runId: string | null;
}
export function parseArgs(argv: string[]): Args {
	const a: Args = {
		design: false,
		run: false,
		report: false,
		rescore: false,
		rescoreStatus: false,
		force: false,
		reason: null,
		arm: null,
		limit: 0,
		runId: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i] ?? "";
		const nx = argv[i + 1];
		if (k === "--design") a.design = true;
		else if (k === "--run") a.run = true;
		else if (k === "--report") a.report = true;
		else if (k === "--rescore") a.rescore = true;
		else if (k === "--rescore-status") a.rescoreStatus = true;
		else if (k === "--force") a.force = true;
		else if (k === "--reason" && nx) {
			a.reason = nx;
			i++;
		} else if (k === "--arm" && nx) {
			const sel = ARM_SELS.find((s) => s === nx);
			if (!sel) throw new Error(`--arm takes ${ARM_SELS.join(" | ")}`);
			a.arm = sel;
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
/** The sealed set, MANIFEST-verified; null when nothing is sealed. */
function sealOrNull(): ReturnType<typeof readSeal> {
	try {
		return readSeal(SEAL);
	} catch (e) {
		throw new Refused(e instanceof Error ? e.message : String(e), 3);
	}
}
/** Load the sealed set, verifying the MANIFEST hash. */
export function loadSeal(): NonNullable<ReturnType<typeof readSeal>> {
	const seal = sealOrNull();
	if (!seal) throw new Refused(`no sealed set at ${SEAL} — run --design`, 3);
	return seal;
}
/** Resolve the arms' legs up front (pings, lane plugin) — all or none. */
async function legsFor(arms: ArmId[]): Promise<Array<[ArmId, ArmLeg]>> {
	const { lanePlugin } = loadSurface(SURFACE);
	const factories = armLegs({ root: ROOT, lanePlugin });
	const legs: Array<[ArmId, ArmLeg]> = [];
	for (const arm of arms) {
		const leg = await factories[arm]();
		if (typeof leg === "string") throw new Refused(`arm ${arm}: ${leg}`, 3);
		legs.push([arm, leg]);
	}
	return legs;
}
/** Run the arms over the sealed set (AC-gated, ping-preflighted). */
export async function run(
	runId: string,
	arms: ArmId[],
	limit: number,
	src?: string,
): Promise<void> {
	acGate();
	const { tasks } = loadSeal();
	const picked = src ? tasks.filter((t) => t.src === src) : tasks;
	for (const [arm, leg] of await legsFor(arms))
		await runArm({
			tasks: picked,
			arm,
			exec: leg.exec,
			resDir: RES,
			runId,
			limit,
			log: (line) => console.log(line),
		});
}
/** Render the decision-grade metrics table from the result JSONLs — one
 *  outcome per task (armRows); transport failures are counted, not scored. */
export async function report(runId: string): Promise<string> {
	const lines: string[] = [`# W792 review arena — run ${runId}`, ""];
	const aggs: ArmAggregate[] = [];
	const failed: string[] = [];
	for (const arm of ARM_IDS) {
		const rows = await armRows(RES, runId, arm);
		const ok = rows.filter((r) => r.runOk);
		if (ok.length) aggs.push(aggregate(arm, ok));
		if (ok.length < rows.length)
			failed.push(`${arm} ${rows.length - ok.length}/${rows.length}`);
	}
	if (!aggs.length)
		throw new Refused(`no results for run ${runId} — nothing to report`, 1);
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
	L("recall (seeded)", (g) => share(g.recall));
	L("file recall", (g) => share(g.fileRecall));
	L("false positives / task", (g) => f2(g.meanFpPerTask));
	L("human-required / task", (g) => f2(g.humanRequiredPerTask));
	L("human noise / clean task", (g) => f2(g.humanNoisePerCleanTask));
	L("converged ≤3 rounds", (g) => `${g.converged}/${g.n}`);
	L("median rounds", (g) => f0(g.medianRounds));
	L("verdict accuracy", (g) => share(g.verdictAccuracy));
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
	if (failed.length)
		lines.push(`Transport failures (not scored): ${failed.join(", ")}.`);
	return lines.join("\n");
}
const stamp = (): string =>
	new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
/** What --rescore and --rescore-status share. */
function rescoreBase(a: Args) {
	return {
		root: ROOT,
		surface: loadSurface(SURFACE),
		resDir: RES,
		env: process.env,
		arms: armsOf(a.arm ?? "all"),
		force: a.force,
		incidentIds: INCIDENTS.map((d) => d.id),
	};
}
/** --rescore-status: which arms are due and why — no LLM call, no AC gate. */
async function rescoreStatusCli(a: Args): Promise<void> {
	const st = await rescoreStatus({
		...rescoreBase(a),
		seal: sealOrNull()?.info ?? null,
	});
	for (const s of st.arms)
		console.log(`${s.arm}: ${s.due ? "DUE" : "idle"} — ${s.why}`);
	if (st.unsealed.length)
		console.log(
			`unsealed incident cases: ${st.unsealed.join(", ")} — re-design the seal to score them`,
		);
	console.log(`RESCORE-STATUS ${JSON.stringify(st)}`);
}
/** --rescore: rerun each due arm over the whole sealed set and ledger its
 *  score delta (AC-gated). Returns the run id (--report renders it). */
async function rescoreCli(a: Args, runId: string | null): Promise<string> {
	if (a.limit || a.src)
		throw new Refused(
			"--rescore scores the whole sealed set — drop --limit / --src",
			1,
		);
	acGate();
	const seal = loadSeal();
	const base = rescoreBase(a);
	const sum = await rescore({
		...base,
		seal: seal.info,
		tasks: seal.tasks,
		reason: a.reason ?? "manual",
		runId: runId ?? `rescore-${stamp()}`,
		legs: armLegs({ root: ROOT, lanePlugin: base.surface.lanePlugin }),
		log: (line) => console.log(line),
	});
	for (const line of sum.lines) console.log(line);
	console.log(`RESCORE ${JSON.stringify(sum)}`);
	return sum.runId;
}
async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	let runId = a.runId;
	if (a.design) {
		const d = design();
		console.log(`sealed ${d.count} tasks @ ${REVIEW_DIR} (sha16 ${d.hash})`);
	}
	if (a.run) {
		if (!runId) runId = stamp();
		await run(runId, armsOf(a.arm ?? "both"), a.limit, a.src);
	}
	if (a.rescoreStatus) await rescoreStatusCli(a);
	if (a.rescore) runId = await rescoreCli(a, runId);
	if (a.report) {
		if (!runId) throw new Refused("--report needs --run-id <id>", 1);
		const md = await report(runId);
		console.log(md);
	}
	if (!a.design && !a.run && !a.report && !a.rescore && !a.rescoreStatus)
		throw new Refused(
			"nothing to do — pass --design / --run / --report / --rescore / --rescore-status",
			1,
		);
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = e instanceof Refused ? e.code : 1;
}
