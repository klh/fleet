// packages/blam/bench/crash/scenarios.ts — the S1-S5 deterministic drivers.
// Each driver seeds a fixture + control plane, injects the failure, runs
// the sweep window (logical ticks — no wall clock, no RNG), and measures
// the scenario's properties + TTD/TTR/false-block/data-loss from plane
// events. Spec: bench/crash/scenario.md; metrics: docs/metrics.md.
import {
	type Fixture,
	makeFixture,
	RUNNER_CMD,
} from "./fixture.ts";
import {
	seedCrashedMerge,
	ScriptedControlPlane,
} from "./plane.ts";
import {
	type Era,
	type RunOutcome,
	type ScenarioId,
	WINDOW_TICKS,
} from "./types.ts";

/** The recycled pid: alive under an unrelated command (argv mismatch). */
const RECYCLED_PID = 424242;
const RECYCLED_CMD = "bun run code-server --port 9100";

/** Base of every driver outcome: no violations, nothing detected. */
function outcome(
	scenario: ScenarioId,
	era: Era,
	run: number,
	props: Record<string, boolean>,
	ttd: number | null,
	ttr: number | null,
	falseBlocks: number,
	dataLoss: number
) {
	return {
		scenario, era, run, properties: props,
		ttdTicks: ttd, ttrTicks: ttr, falseBlocks, dataLoss,
	} satisfies RunOutcome;
}

/** S1 — C1 registry-lag: branch + live stand-in exist BEFORE the registry
 * entry lands; the sweep runs inside the lag window. pre retires the
 * mid-spawn lane (registry sole truth); post revalidates ground truth at
 * act time (branch on disk + stand-in alive) and keeps it. */
export function s1(era: Era, run: number): RunOutcome {
	const { fx, plane } = s1world(era);
	for (let t = 0; t < WINDOW_TICKS; t++) plane.sweepCycle();
	const ev = plane.events;
	const falseRetire = ev.some((e) => e.kind === "retire" && e.subject === "work/W-900");
	const guard = ev.find((e) => e.kind === "skip-alive" && e.subject === "work/W-900");
	fx.dispose();
	return outcome(
		"S1", era, run,
		{ "no-false-retire": !falseRetire },
		guard ? guard.tick : null,
		null,
		falseRetire ? 1 : 0,
		0
	);
}

function s1world(era: Era): {
	fx: Fixture;
	plane: ScriptedControlPlane;
	lane: { pid: number; kill(): void };
} {
	const fx = makeFixture("s1");
	const plane = new ScriptedControlPlane(era);
	plane.attach(fx);
	plane.init(fx.repo);
	const lane = plane.dispatchLane({ branch: "work/W-900", sid: "s1-lane" });
	return { fx, plane, lane };
}

/** S2 — C2 liveness-forgery: a crashed merge runner's marker carries a
 * RECYCLED pid — alive in the table, but under an unrelated command. pre
 * trusts kill(pid,0) (forged alive) and defers the heal forever; post
 * demands pid+argv identity and heals in the first cycle. */
export function s2(era: Era, run: number): RunOutcome {
	const { fx, plane } = world(era, "s2");
	seedCrashedMerge(plane, fx, "work/W-998", {
		pid: RECYCLED_PID,
		cmd: RUNNER_CMD,
		ts: 0,
	});
	// the recycled pid: live, but the wrong command (argv mismatch)
	fx.procs.set(RECYCLED_PID, { pid: RECYCLED_PID, cmd: RECYCLED_CMD, alive: true });
	for (let t = 0; t < WINDOW_TICKS; t++) plane.sweepCycle();
	const ev = plane.events;
	const healed = ev.some((e) => e.kind === "heal");
	const guard = ev.find((e) => e.kind === "heal");
	fx.dispose();
	return outcome(
		"S2", era, run,
		{ "debris-healed": healed },
		guard ? guard.tick : null,
		guard ? guard.tick : null,
		0,
		0
	);
}

/** Shared world builder: fixture + plane attached + inited. */
function world(era: Era, tag: string): {
	fx: Fixture;
	plane: ScriptedControlPlane;
} {
	const fx = makeFixture(tag);
	const plane = new ScriptedControlPlane(era);
	plane.attach(fx);
	plane.init(fx.repo);
	return { fx, plane };
}

/** S3 — C3 check-then-act: the sweep's check sees branch `work/W-901`
 * (unregistered — park drops the entry), the park-rename fires in the
 * injection window BETWEEN check and act, and the act hits the vanished
 * name. pre fires the retire on the stale name; post revalidates at act
 * time and skips. */
export function s3(era: Era, run: number): RunOutcome {
	const { fx, plane } = world(era, "s3");
	const lane = plane.dispatchLane({ branch: "work/W-901", sid: "s3-lane" });
	lane.kill();
	plane.midSweepHook = () => {
		plane.parkRename("work/W-901", "work/W-901-parked");
	};
	for (let t = 0; t < WINDOW_TICKS; t++) plane.sweepCycle();
	const ev = plane.events;
	const vanished = ev.some((e) => e.kind === "retire-vanished");
	const guard = ev.find((e) => e.kind === "skip-vanished");
	fx.dispose();
	return outcome(
		"S3", era, run,
		{ "no-retire-on-vanished": !vanished },
		guard ? guard.tick : null,
		null,
		0,
		0
	);
}

/** S4 — R1 debris-blocks-recovery: a ladder run died mid-merge leaving
 * MERGE_HEAD + staged content; the NEXT branch is already queued. pre
 * abort-only recovery cannot clear the debris, blames the queued branch
 * and force-prunes (data loss); post heals debris to a ref in cycle one
 * and merges the next branch cleanly. */
export function s4(era: Era, run: number): RunOutcome {
	const { fx, plane } = world(era, "s4");
	seedCrashedMerge(plane, fx, "work/W-999", { pid: 5001, cmd: RUNNER_CMD, ts: 0 });
	plane.dispatchLane({ branch: "work/W-902", sid: "s4-lane" });
	plane.queueMerge("work/W-902");
	for (let t = 0; t < WINDOW_TICKS; t++) plane.sweepCycle();
	const ev = plane.events;
	const healed = ev.find((e) => e.kind === "heal");
	const pruned = ev.some((e) => e.kind === "force-prune");
	const blamed = ev.some((e) => e.kind === "branch-failed" && e.subject === "work/W-902");
	const merged = ev.find((e) => e.kind === "merge-ok" && e.subject === "work/W-902");
	fx.dispose();
	return outcome(
		"S4", era, run,
		{
			"debris-cleared-in-cycle": healed !== undefined && healed.tick === 1,
			"next-not-falsely-failed": !blamed,
			"no-data-loss": !pruned,
		},
		healed ? 1 : (ev.some((e) => e.kind === "recovery-failed") ? 1 : null),
		merged ? merged.tick : null,
		blamed ? 1 : 0,
		pruned ? 1 : 0
	);
}

/** S5 — S1 foreign-merge-conclusion: a runner is LIVE mid-merge (MERGE_HEAD
 * + marker pid 6001 alive); lane B stages its own file and commits. pre
 * lets the bare commit conclude the foreign merge (two-parent commit);
 * post refuses while a foreign marker is live, then lets the runner's own
 * conclusion and lane B's retry pass (gate precision control). */
export function s5(era: Era, run: number): RunOutcome {
	const { fx, plane } = world(era, "s5");
	plane.seedRunner(6001);
	seedCrashedMerge(plane, fx, "work/W-997", { pid: 6001, cmd: RUNNER_CMD, ts: 0 });
	plane.dispatchLane({ branch: "work/W-903", sid: "s5-lane" });
	const refused = plane.laneCommit({ pid: 7100 }, "laneB.txt", "lane b\n", "lane b work");
	for (let t = 0; t < 1; t++) plane.sweepCycle();
	const ev = plane.events;
	const foreign = ev.some((e) => e.kind === "commit-foreign");
	const refusedEv = ev.some((e) => e.kind === "commit-refused");
	plane.runnerFinish(6001);
	const retry = plane.laneCommit({ pid: 7100 }, "laneB.txt", "lane b\n", "lane b retry");
	fx.dispose();
	return outcome(
		"S5", era, run,
		{
			"no-foreign-conclusion": !foreign,
			"control-commit-passes": retry === "landed",
		},
		refusedEv || refused === "refused" ? 1 : null,
		null,
		0,
		0
	);
}

