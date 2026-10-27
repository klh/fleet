// review-rescore-run.ts — W1476 (b): the rescore execution half. Status says
// which arms are due and why (no LLM calls); runArm is the resumable arm
// runner (moved from review-run.ts, generalized over executors so the lane
// arm and injected test arms ride it); armDelta scores against the arm's
// previous scored run; rescore runs every due arm over the whole sealed set
// and ledgers one row per arm. State lives in review-rescore.ts.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { jsonl } from "./core.ts";
import { MAX_ROUNDS, type ReviewTask } from "./review-core.ts";
import type { ArmRun } from "./review-pipeline.ts";
import {
	ARM_IDS,
	type ArmPrint,
	acquireLock,
	appendLedger,
	armPrint,
	changedKeys,
	dirtyPaths,
	headBlobs,
	headOf,
	type LedgerRow,
	type LedgerStatus,
	type LockInfo,
	lastRow,
	lockLive,
	readLedger,
	readLock,
	releaseLock,
	type ScoreDelta,
	type SealInfo,
	type Surface,
	surfacePaths,
} from "./review-rescore.ts";
import {
	type ArmAggregate,
	type ArmId,
	type ArmOutcome,
	aggregate,
	scoreOutcome,
} from "./review-score.ts";

const errText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- status

export interface ArmStatus extends ArmPrint {
	arm: ArmId;
	/** part keys that differ from the arm's last scored row */
	changed: string[];
	last: { ts: string; status: LedgerStatus; runId: string | null } | null;
	due: boolean;
	why: string;
}

export interface RescoreStatus {
	head: string;
	seal: string | null;
	sealed: number;
	/** incident case ids defined but not sealed yet (re-design pending) */
	unsealed: string[];
	locked: LockInfo | null;
	arms: ArmStatus[];
}

export interface StatusOptions {
	root: string;
	surface: Surface;
	seal: SealInfo | null;
	resDir: string;
	env: Record<string, string | undefined>;
	arms?: readonly ArmId[];
	force?: boolean;
	incidentIds?: string[];
	now?: number;
	/** the caller holds the singleflight lock (rescore's own read) */
	lockHeld?: boolean;
}

const DESIGN_HINT = "bun packages/belt/bench/arena/review-run.ts --design";

function dueOf(o: {
	opts: StatusOptions;
	arm: ArmId;
	print: ArmPrint;
	locked: LockInfo | null;
	scored: LedgerRow | null;
	last: LedgerRow | null;
	changed: string[];
	now: number;
}): { due: boolean; why: string } {
	if (!o.opts.seal)
		return { due: false, why: `no sealed set — ${DESIGN_HINT}` };
	if (o.locked)
		return { due: false, why: `rescore running (pid ${o.locked.pid})` };
	const unset = o.opts.surface.arms[o.arm].required.filter(
		(name) => !o.opts.env[name],
	);
	if (unset.length) return { due: false, why: `unset ${unset.join(", ")}` };
	if (o.opts.force) return { due: true, why: "forced" };
	if (o.print.dirty.length)
		return {
			due: false,
			why: `dirty surface: ${o.print.dirty.join(", ")}`,
		};
	if (o.scored && !o.changed.length) return { due: false, why: "unchanged" };
	const until = o.last
		? Date.parse(o.last.ts) + o.opts.surface.minIntervalSeconds * 1000
		: 0;
	if (until > o.now)
		return { due: false, why: `debounced until ${iso(until)}` };
	return {
		due: true,
		why: o.scored ? `changed: ${o.changed.join(", ")}` : "baseline",
	};
}

/** Which arms are due for a rescore, and why — git + ledger reads only. */
export async function rescoreStatus(o: StatusOptions): Promise<RescoreStatus> {
	const now = o.now ?? Date.now();
	const ledger = await readLedger(o.resDir);
	const lock = o.lockHeld ? null : readLock(o.resDir);
	const locked = lock && lockLive(lock, now) ? lock : null;
	const paths = surfacePaths(o.surface);
	const blobs = headBlobs(o.root, paths);
	const dirty = dirtyPaths(o.root, paths);
	const sealIds = new Set(o.seal?.ids ?? []);
	const arms = (o.arms ?? ARM_IDS).map((arm): ArmStatus => {
		const print = armPrint({
			root: o.root,
			surface: o.surface,
			arm,
			blobs,
			dirty,
			env: o.env,
			seal: o.seal?.hash ?? null,
		});
		const scored = lastRow(ledger, arm, "scored");
		const last = lastRow(ledger, arm);
		const changed = scored
			? changedKeys(scored.parts, print.parts)
			: Object.keys(print.parts).sort();
		return {
			arm,
			...print,
			changed,
			last: last
				? { ts: last.ts, status: last.status, runId: last.runId }
				: null,
			...dueOf({ opts: o, arm, print, locked, scored, last, changed, now }),
		};
	});
	return {
		head: headOf(o.root),
		seal: o.seal?.hash ?? null,
		sealed: sealIds.size,
		unsealed: o.seal
			? (o.incidentIds ?? []).filter((id) => !sealIds.has(id))
			: [],
		locked,
		arms,
	};
}

// ---------------------------------------------------------------- runs

export type ArmExec = (task: ReviewTask) => Promise<ArmRun>;

export interface ArmLeg {
	exec: ArmExec;
	/** lane arm: the model pin and plugin version the run rides */
	model?: string;
	plugin?: string;
}

/** Resolves a due arm's executor, or says why it cannot run (a leg port
 *  down, no lane leg) — called only for due arms, so idle checks never ping. */
export type ArmLegFactory = () => Promise<ArmLeg | string>;

export interface ArmRowOutcome extends ArmOutcome {
	runOk: boolean;
	err?: string;
}

export const rowFile = (resDir: string, runId: string, arm: ArmId): string =>
	join(resDir, `rev-${runId}-${arm}.jsonl`);

const failedRun = (arm: ArmId, err: string): ArmRun => ({
	arm,
	findings: [],
	verdict: "FAIL",
	roundsToPass: MAX_ROUNDS + 1,
	openBlockers: [],
	tokIn: 0,
	tokOut: 0,
	calls: 0,
	wallMs: 0,
	trace: [],
	ok: false,
	err,
});

/** Run one arm over the tasks — resumable JSONL (run-ok tasks are skipped),
 *  2 workers; an executor that throws records a failed row. Returns the
 *  number of tasks run. */
export async function runArm(o: {
	tasks: ReviewTask[];
	arm: ArmId;
	exec: ArmExec;
	resDir: string;
	runId: string;
	limit?: number;
	log?: (line: string) => void;
}): Promise<number> {
	mkdirSync(o.resDir, { recursive: true });
	const file = rowFile(o.resDir, o.runId, o.arm);
	const done = new Set<string>();
	for await (const r of jsonl<{ taskId: string; runOk: boolean }>(file)) {
		if (r.runOk) done.add(r.taskId);
	}
	const todo = o.tasks.filter((t) => !done.has(t.id));
	if (o.limit && o.limit > 0) todo.splice(o.limit);
	const total = todo.length;
	const worker = async (): Promise<void> => {
		while (todo.length > 0) {
			const t = todo.shift();
			if (!t) break;
			let run: ArmRun;
			try {
				run = await o.exec(t);
			} catch (error) {
				run = failedRun(o.arm, errText(error));
			}
			const out = scoreOutcome({
				arm: o.arm,
				taskId: t.id,
				src: t.src,
				defects: t.defects,
				findings: run.findings,
				roundsToPass: run.roundsToPass,
				verdict: run.verdict,
				openBlockers: run.openBlockers,
				tokIn: run.tokIn,
				tokOut: run.tokOut,
				calls: run.calls,
				wallMs: run.wallMs,
			});
			appendFileSync(
				file,
				`${JSON.stringify({ ...out, runOk: run.ok, err: run.err })}\n`,
			);
			o.log?.(
				`${o.arm}/${t.id} ${run.verdict} r${run.roundsToPass} in${out.tokIn} ok=${run.ok}${run.err ? ` ${run.err}` : ""}`,
			);
		}
	};
	await Promise.all([worker(), worker()]);
	return total;
}

/** One outcome per task: the newest run-ok row wins, else the newest row. */
export async function armRows(
	resDir: string,
	runId: string,
	arm: ArmId,
): Promise<ArmRowOutcome[]> {
	const byTask = new Map<string, ArmRowOutcome>();
	for await (const r of jsonl<ArmRowOutcome>(rowFile(resDir, runId, arm))) {
		const held = byTask.get(r.taskId);
		if (!held || r.runOk || !held.runOk) byTask.set(r.taskId, r);
	}
	return [...byTask.values()];
}

// ---------------------------------------------------------------- delta

const deltaOf = (cur: ArmAggregate, prev: ArmAggregate) => ({
	recall: cur.recall - prev.recall,
	fileRecall: cur.fileRecall - prev.fileRecall,
	fpPerTask: cur.meanFpPerTask - prev.meanFpPerTask,
	humanNoisePerCleanTask:
		cur.humanNoisePerCleanTask - prev.humanNoisePerCleanTask,
	verdictAccuracy: cur.verdictAccuracy - prev.verdictAccuracy,
	tokInP50:
		cur.tokInP50 !== null && prev.tokInP50 !== null
			? cur.tokInP50 - prev.tokInP50
			: null,
});

/** The score delta against the arm's previous scored run: over the task ids
 *  both runs scored while its rows survive (new incident cases counted
 *  apart), else between the stored whole-run aggregates. */
export async function armDelta(o: {
	resDir: string;
	arm: ArmId;
	prev: LedgerRow | null;
	cur: ArmOutcome[];
	score: ArmAggregate;
}): Promise<ScoreDelta | null> {
	if (!o.prev?.score) return null;
	const prevRows = o.prev.runId
		? (await armRows(o.resDir, o.prev.runId, o.arm)).filter((r) => r.runOk)
		: [];
	const prevIds = new Set(prevRows.map((r) => r.taskId));
	const curIds = new Set(o.cur.map((r) => r.taskId));
	const common = o.cur.filter((r) => prevIds.has(r.taskId));
	if (common.length)
		return {
			basis: "common",
			n: common.length,
			newTasks: o.cur.length - common.length,
			dropped: prevRows.filter((r) => !curIds.has(r.taskId)).length,
			...deltaOf(
				aggregate(o.arm, common),
				aggregate(
					o.arm,
					prevRows.filter((r) => curIds.has(r.taskId)),
				),
			),
		};
	return {
		basis: "full",
		n: o.cur.length,
		newTasks: null,
		dropped: null,
		...deltaOf(o.score, o.prev.score),
	};
}

// ---------------------------------------------------------------- render

/** A 0..1 share as a percentage. */
export const share = (x: number | null | undefined): string =>
	typeof x === "number" && Number.isFinite(x)
		? `${(x * 100).toFixed(1)}%`
		: "—";
const pp = (x: number): string =>
	`${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

/** One line per ledger row — the CLI echo and the suspenders event note. */
export function ledgerLine(r: LedgerRow): string {
	const who = r.model ? `${r.arm} (${r.model})` : r.arm;
	if (!r.score) return `${who}: ${r.status} — ${r.err ?? "no score"}`;
	const s = r.score;
	const d = r.delta;
	const head = `${who}: ${r.status} n=${s.n} recall ${share(s.recall)} fp/task ${s.meanFpPerTask.toFixed(2)} verdict ${share(s.verdictAccuracy)}`;
	const vs = d
		? ` | Δ ${d.basis} n=${d.n}${d.newTasks ? ` +${d.newTasks} new` : ""}: recall ${pp(d.recall)} fp/task ${signed(d.fpPerTask)} verdict ${pp(d.verdictAccuracy)}`
		: r.status === "scored"
			? " | baseline"
			: "";
	return `${head}${vs}${r.err ? ` — ${r.err}` : ""}`;
}

// ---------------------------------------------------------------- rescore

export interface RescoreOptions
	extends Omit<StatusOptions, "seal" | "now" | "lockHeld"> {
	seal: SealInfo;
	tasks: ReviewTask[];
	reason: string;
	runId: string;
	legs: Partial<Record<ArmId, ArmLegFactory>>;
	now?: () => number;
	log?: (line: string) => void;
}

export interface RescoreSummary {
	runId: string;
	head: string | null;
	seal: string;
	rows: LedgerRow[];
	/** arms not run, with why */
	skipped: Partial<Record<ArmId, string>>;
	lines: string[];
}

function summaryOf(
	o: RescoreOptions,
	head: string | null,
	rows: LedgerRow[],
	skipped: Partial<Record<ArmId, string>>,
): RescoreSummary {
	return {
		runId: o.runId,
		head,
		seal: o.seal.hash,
		rows,
		skipped,
		lines: [
			...rows.map(ledgerLine),
			...Object.entries(skipped).map(([arm, why]) => `${arm}: not run — ${why}`),
		],
	};
}

async function resolveLeg(
	factory: ArmLegFactory | undefined,
): Promise<ArmLeg | string> {
	if (!factory) return "no executor";
	try {
		return await factory();
	} catch (error) {
		return errText(error);
	}
}

async function rescoreArm(
	o: RescoreOptions,
	st: ArmStatus,
	head: string,
	prev: LedgerRow | null,
	clock: () => number,
): Promise<LedgerRow> {
	const leg = await resolveLeg(o.legs[st.arm]);
	const base = {
		arm: st.arm,
		reason: o.reason,
		fingerprint: st.fingerprint,
		parts: st.parts,
		changed: st.changed,
		head,
		seal: o.seal.hash,
		prevRunId: prev?.runId ?? null,
	};
	if (typeof leg === "string")
		return {
			...base,
			ts: iso(clock()),
			status: "skipped",
			runId: null,
			model: null,
			plugin: null,
			score: null,
			runFailures: 0,
			delta: null,
			err: leg,
		};
	const run = {
		tasks: o.tasks,
		arm: st.arm,
		exec: leg.exec,
		resDir: o.resDir,
		runId: o.runId,
		log: o.log,
	};
	await runArm(run);
	await runArm(run); // one resume pass retries the transport failures
	const all = await armRows(o.resDir, o.runId, st.arm);
	const ok = all.filter((r) => r.runOk);
	const runFailures = all.length - ok.length;
	const score = ok.length ? aggregate(st.arm, ok) : null;
	const scored =
		score !== null && runFailures <= o.surface.maxFailureRate * all.length;
	const firstErr = all.find((r) => !r.runOk)?.err;
	return {
		...base,
		ts: iso(clock()),
		status: scored ? "scored" : "failed",
		runId: o.runId,
		model: leg.model ?? null,
		plugin: leg.plugin ?? null,
		score,
		runFailures,
		delta:
			scored && score
				? await armDelta({ resDir: o.resDir, arm: st.arm, prev, cur: ok, score })
				: null,
		...(scored
			? {}
			: {
					err: `${runFailures}/${all.length} tasks failed${firstErr ? `: ${firstErr}` : ""}`,
				}),
	};
}

/** Rescore every due arm over the whole sealed set: one ledger row per due
 *  arm (scored | failed | skipped), singleflight under the lock. */
export async function rescore(o: RescoreOptions): Promise<RescoreSummary> {
	const clock = o.now ?? Date.now;
	const arms = o.arms ?? ARM_IDS;
	const rows: LedgerRow[] = [];
	const skipped: Partial<Record<ArmId, string>> = {};
	if (!acquireLock(o.resDir, o.reason, clock())) {
		const why = `rescore running (pid ${readLock(o.resDir)?.pid ?? "?"})`;
		for (const arm of arms) skipped[arm] = why;
		return summaryOf(o, null, rows, skipped);
	}
	try {
		const status = await rescoreStatus({
			...o,
			arms,
			now: clock(),
			lockHeld: true,
		});
		const ledger = await readLedger(o.resDir);
		for (const st of status.arms) {
			if (!st.due) {
				skipped[st.arm] = st.why;
				continue;
			}
			const prev = lastRow(ledger, st.arm, "scored");
			const row = await rescoreArm(o, st, status.head, prev, clock);
			appendLedger(o.resDir, row);
			rows.push(row);
			o.log?.(ledgerLine(row));
		}
		return summaryOf(o, status.head, rows, skipped);
	} finally {
		releaseLock(o.resDir);
	}
}
