// launch-refusal.ts — W2317 (Kueue pattern 5): the ONE seam where a launch
// refusal becomes either a Transient backoff+requeue (release the
// reservation and retry — Kueue's Retry) or a Permanent close (FAILED on the
// graph + NEED_DECISION surfaced — Kueue's Rejected). The classifier and
// the RequeueSpec vocabulary live in launch-fencing.ts (the program
// contract's ONE home); this module owns the two EFFECTS:
//
//   launchFailureExit — the launcher catch body (lane-launch.ts): classify
//     THIS attempt's failure and either record the existing backoff
//     (Transient) or close the item FAILED and surface the decision
//     (Permanent). Never a third behavior.
//
//   unknownSurfaceGate — the dispatch-cycle read (dispatch-next.ts):
//     unknown-liveness intents that exhausted their bounded re-probe are
//     SURFACED (one NEED_DECISION per episode, grinder-flag style) — the
//     probe-down state is an event, never a wedge (pattern 5: "a check that
//     is not Active makes the queue Inactive — surfaced, never a wedge").
import {
	classifyLaunchFailure,
	launchFailBackoff,
	launchLogAppended,
} from "./launch-backoff.ts";
import {
	classifyLaunchRefusal,
	heldLaunchReport,
	type HeldLaunchReport,
	type LaunchRefusalVerdict,
	type SurfacedIntent,
} from "./launch-fencing.ts";

/** launchFailureExit effects, in verdict order. The backoff value is the
 *  Transient effect (null = no backoff record exists/needed); closed+surfaced
 *  carry the Permanent effect. Pure over its inputs — the store writes ride
 *  the passed effect callbacks so tests share the seam. */
export type LaunchFailureExit = {
	verdict: LaunchRefusalVerdict;
	/** Transient: the scheduled backoff (existing launchFailBackoff record) */
	backoff: { kind: string; eligibleAt: number } | null;
	/** Permanent: the item was closed FAILED on the graph */
	closed: boolean;
	/** Permanent: the NEED_DECISION was emitted */
	surfaced: boolean;
	note: string;
};

type EffectIO = {
	/** Transient effect: record the existing attempt-scoped backoff */
	backoff: () => { kind: string; eligibleAt: number } | null;
	/** Permanent effect: work fail <item> (FAILED on the graph) */
	fail: (note: string) => { code: number; out: string };
	/** Permanent effect: coord emit NEED_DECISION (once per refusal) */
	surface: (note: string) => void;
	log: (msg: string) => void;
};

/** Classify a failed launch and apply its ONE effect. The disposition comes
 *  from classifyLaunchRefusal over the failure evidence (code from
 *  classifyLaunchFailure, exit code, stderr); the Transient effect is the
 *  existing backoff ladder — this seam never invents a second retry shape. */
export function launchFailureExit(
	item: string,
	evidence: {
		/** the failed attempt's appended evidence, if any (W1165) */
		appended: string | null;
		exitCode?: number | null;
	},
	now: number,
	io: EffectIO,
): LaunchFailureExit {
	const failure = classifyLaunchFailure(evidence.appended ?? "", now);
	const verdict = classifyLaunchRefusal({
		code: failure.code,
		...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
	});
	if (verdict.disposition === "Transient") {
		const backoff = io.backoff();
		return {
			verdict,
			backoff,
			closed: false,
			surfaced: false,
			note: backoff
				? `${verdict.reason}; retry eligible ${new Date(backoff.eligibleAt).toISOString()}`
				: verdict.reason,
		};
	}
	// Permanent: no machinery retry — FAILED + NEED_DECISION, work retry
	// stays the operator's door. A close failure is loud but never converts
	// a Permanent into a retry (misclassification risk is the worse evil).
	const failed = io.fail(`${verdict.reason} (W2317 permanent launch refusal)`);
	const closed = failed.code === 0;
	const note = `${item}: ${verdict.reason} — launch refused permanently, item FAILED (work retry is the operator's door)`;
	io.surface(note);
	io.log(`launch-refusal Permanent ${item} — ${verdict.reason}`);
	return { verdict, backoff: null, closed, surfaced: true, note };
}

/** One surfaced unknown-liveness intent → the NEED_DECISION note text. */
export const unknownSurfaceNote = (row: SurfacedIntent): string =>
	`${row.item}: unknown lane liveness after ${row.attempts}/${row.maxAttempts} re-probes (sid ${row.sid}, pid ${String(
		row.pid,
	)}) — capacity released, not held; operator door: dispatch intent fail --item ${row.item} --evidence <why>`;

/** The lane-launch.ts catch adapter: one call, one disposition — the whole
 *  failed-launch unwind (classification + its ONE effect) lives here so the
 *  1200-line-capped launch machine keeps a single-line delegation. Evidence
 *  is the failed attempt's own appended bytes (W1165) + the executor exit
 *  code; a never-launched attempt (no process) classifies without them. */
export function launchFailureCatch(
	launch: {
		item: string;
		laneLog: string;
		attempt: number;
		logAtSpawn: number;
		proc: Pick<Bun.Subprocess, "exitCode"> | undefined;
	},
	io: {
		project: string;
		sid: string;
		store: Parameters<typeof launchFailBackoff>[0];
		run: (cmd: string[]) => { code: number; out: string };
		workCli: (...args: string[]) => string[];
		coordCli: (...args: string[]) => string[];
		log: (msg: string) => void;
	},
	now = Date.now(),
): LaunchFailureExit {
	const launched = launch.proc !== undefined && launch.proc.exitCode !== null;
	const failBackoff = (): { kind: string; eligibleAt: number } | null =>
		launched
			? launchFailBackoff(
					io.store,
					io.project,
					launch.item,
					launch.laneLog,
					launch.attempt,
					launch.logAtSpawn,
				)
			: null;
	return launchFailureExit(
		launch.item,
		{
			appended: launched
				? launchLogAppended(launch.laneLog, launch.logAtSpawn)
				: null,
			...(launched ? { exitCode: launch.proc?.exitCode ?? null } : {}),
		},
		now,
		{
			backoff: failBackoff,
			fail: (note) =>
				io.run(io.workCli("fail", launch.item, "--as", io.sid, "--note", note)),
			surface: (note) => {
				io.run(
					io.coordCli(
						"emit",
						"NEED_DECISION",
						"--as",
						"dispatch",
						"--scope",
						"suspenders",
						"--note",
						note,
					),
				);
			},
			log: (m) => io.log(m),
		},
	);
}

/** The dispatch-cycle surface gate: read heldLaunchReport ONCE and, for each
 *  episode that JUST exhausted its bound, emit one NEED_DECISION. Rows that
 *  stay exhausted do not re-emit (the episode fact is the grinder-style
 *  flag; a fresh reservation or a fail clears it). Returns the whole report
 *  so the caller reuses the same held set — a second read would advance the
 *  probe twice in one cycle. */
export function unknownSurfaceGate(
	store: Parameters<typeof heldLaunchReport>[0],
	project: string,
	emit: (note: string) => void,
	log: (msg: string) => void,
	now = Date.now(),
): HeldLaunchReport {
	const report = heldLaunchReport(store, project, now);
	for (const row of report.surfaced) {
		if (!row.justExhausted) continue;
		const note = unknownSurfaceNote(row);
		emit(note);
		log(`launch-refusal surfaced ${row.item} — unknown liveness, re-probe bound exhausted`);
	}
	return report;
}
