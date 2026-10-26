#!/usr/bin/env bun
// fleet-loop.ts — the generic merge/dispatch loop lifted from gaps'
// dk.threads.gaps-fleet-loop (W59): the loop SHELL is fleet machinery, the
// merge LADDER and dispatch POLICY stay per-repo, invoked as child scripts.
//
//   bun fleet-loop.ts once  --repo <dir> [options]
//   bun fleet-loop.ts watch --repo <dir> [options]
//
// Each cycle:
//   1. abort leftover merge state
//   2. merge every branch matching --glob that is ahead of --main, through
//      the ladder child (--ladder template with {branch}; default: plain
//      git merge --no-ff)
//   --dispatch-cmd <template> runs once per cycle after merges (policy lives there)
//   3. retire merged branches' worktree + branch (pid-guarded, honest RETIRE-BLOCKED)
//   4. stall watchdog · 5. wisdom sweep · 6. rogue sweep · 7. reclaim sweep
//      (W376) — fail-isolated cycle steps after the merge/dispatch core
//
// Hardened per the gaps incidents (2026-09-28): cycles run as killable --once
// children under a watchdog (a hung spawnSync froze the gaps daemon 26h);
// FAIL lines carry the ladder's last 3 output lines (a pnpm-ENOENT cascade
// was invisible for an hour); 3-strike PARK; live-lane pid guard on retire;
// MERGE_HEAD abort, never reset --hard on a shared checkout.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	controllerWatchBoundary,
	currentControllerIdentity,
} from "../../scripts/lib/controller-fence.ts";
import { broadcastNote } from "../coord/bus.ts";
import { wisdomSweep } from "../coord/wisdom.ts";
import { flagFns, parseLoopConfig } from "../lib/fleet-loop/config.ts";
import { runDispatch } from "../lib/fleet-loop/dispatch.ts";
import { createMaintenanceSweep } from "../lib/fleet-loop/maintenance.ts";
import { createMergeLadder } from "../lib/fleet-loop/merge.ts";
import { createReclaimSweep } from "../lib/fleet-loop/reclaim-sweep.ts";
import { createRetire } from "../lib/fleet-loop/retire.ts";
import { createRogueSweep } from "../lib/fleet-loop/rogue-sweep.ts";
import { createRuntime } from "../lib/fleet-loop/runtime.ts";
import { createRuntimeSync } from "../lib/fleet-loop/runtime-sync.ts";
import { createStallWatch } from "../lib/fleet-loop/stall-watch.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
// W641: the ladder's govdb lease gate — shared flush predicate, one source
import {
	doneShaResolves,
	gitInProgress,
	gitMidOp,
	itemClaimOf,
	mergeHoldActive,
} from "../lib/lanes/ladder-lease.ts";
import { laneProcessIdentity } from "../lib/lanes/lane-liveness.ts";
import { flushOnDoneWait } from "../lib/fleet-loop/merge-on-done.ts";
// W911: the plaid posture switch — read/write .fleet/posture (the file
// dispatch-next reads once per invocation).
import {
	parsePosture,
	postureWidth,
	readPosture,
	writePosture,
} from "../lib/plaid/plaid.ts";

const config = parseLoopConfig(process.argv.slice(2), import.meta.dir);
const {
	argv,
	MODE,
	REPO,
	CALLER_REPO,
	GLOB,
	LADDER_TIMEOUT_MS,
	DISPATCH,
	EVERY_MS,
	CYCLE_TIMEOUT_MS,
} = config;
const runtime = createRuntime(config);
const { val, num } = flagFns(argv);
const { log, sh, lanes } = runtime;
const { laneIsAlive, retireMerged } = createRetire(runtime);
const { mergeOne, mergeRunnerAlive, healCrashedMerge } = createMergeLadder({
	...runtime,
	CALLER_REPO,
	LADDER: config.LADDER,
	LADDER_TIMEOUT_MS,
	laneIsAlive,
	retireMerged,
});
const { stallWatch } = createStallWatch({
	...runtime,
	STALL_WARN_MS: config.STALL_WARN_MS,
});
const { rogueSweep } = createRogueSweep({
	...runtime,
	manifestPath: join(import.meta.dir, "..", "..", "deploy", "services.yaml"),
});
// W376: the per-cycle reclaim pass rides the ONE `work reclaim all` core
// (lib/reclaim-all.ts); releases broadcast on the coord bus (24h note-dedupe).
const { reclaimSweep } = createReclaimSweep({
	...runtime,
	store: openStore,
	broadcast: (note: string) => broadcastNote(note, "fleet-loop"),
});

// W779 heartbeat: the no-port launchd maintenance agents as typed tasks —
// the cycle fires every due task, the task owns its cadence and fan-out.
// Fail-isolated (the wisdom-sweep rule): a registry bug can never take
// down the merge/dispatch core.
const { maintenanceSweep } = createMaintenanceSweep(runtime);
const runMaintenanceSweep = (): void => {
	try {
		const r = maintenanceSweep();
		if (r.ran.length > 0 || r.failed.length > 0)
			log(
				`MAINT swept ran=${r.ran.length} fail=${r.failed.length} skip=${r.skipped}`,
			);
	} catch (e) {
		log(
			`MAINT sweep failed (fail-isolated): ${e instanceof Error ? e.message : String(e)}`,
		);
	}
};

// W821 post-merge runtime sync: merged main must reach the serve surfaces —
// syncHarness the installed prefix and kickstart the touched labels, else
// the fleet serves stale code all day (2026-10-19 root cause).
const { runtimeSync } = createRuntimeSync({ ...runtime, MAIN: config.MAIN });

// the ladder and dispatch commands are repo-OWNER config (same trust class as
// a Makefile): {branch} is substituted, then the template runs via sh -c in
// the repo dir — see docs/fleet-loop.md.
const runTemplate = (
	template: string,
	branch: string,
	timeoutMs: number,
): { code: number; tail: string } => {
	const cmd = template.split("{branch}").join(branch);
	const p = Bun.spawnSync(["/bin/sh", "-c", cmd], {
		cwd: CALLER_REPO,
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	const tail =
		`${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-3)
			.join(" | ");
	return { code: p.exitCode ?? 1, tail };
};

async function cycle(): Promise<void> {
	// 1. never enter a cycle with leftover merge state. MERGE_HEAD is either
	// a LIVE merge (another runner mid-flight — hands off) or crashed-run
	// debris (heal: surgical abort, guarded reset as last resort).
	// W1072.2: a hold or a non-merge mid-op (cherry-pick/rebase) defers the
	// heal too — operator state is never aborted/reset by the ladder.
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		const live = mergeRunnerAlive();
		if (live) log(`MERGE in progress by pid ${live} — cycle leaves it alone`);
		else if (mergeHoldActive(REPO) || gitMidOp(REPO))
			log(
				"MERGE-DEFER cycle — merge state + operator hold/mid-op, heal deferred",
			);
		else healCrashedMerge();
	}

	// 2. merge every ahead branch through the ladder (fail-isolated per branch)
	const branches = sh([
		"git",
		"branch",
		"--list",
		GLOB,
		"--format",
		"%(refname:short)",
	])
		.split("\n")
		.filter(Boolean);
	for (const b of branches) mergeOne(b);

	// 2.5 runtime sync (W821): merged main reaches the serve surfaces —
	// fail-isolated (the wisdom-sweep rule): a sync bug can never take down
	// the merge/dispatch loop.
	try {
		runtimeSync();
	} catch (e) {
		log(
			`RUNTIME-SYNC failed (fail-isolated): ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 3. refill the fleet — policy lives in the repo's dispatch script
	if (DISPATCH) runTemplate(DISPATCH, "", LADDER_TIMEOUT_MS);

	// 4. stall watchdog (autow428): warn while the claim is still warm
	stallWatch();

	// 5. wisdom sweep (W469): fleet-wide read-only correction detector —
	// stub mints, evidence-less closures, broadcast floods. Its ONLY writes
	// are NEED_DECISION emissions + finding.wisdom.* facts; fail-isolated so
	// a sweep bug can never take down the merge/dispatch loop.
	try {
		const w = wisdomSweep();
		if (w.emitted > 0)
			log(`WISDOM ${w.flagged} flagged, ${w.emitted} NEED_DECISION emitted`);
	} catch (e) {
		log(
			`WISDOM sweep failed (fail-isolated): ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 6. rogue sweep (W266.3): plane processes outside launchd supervision —
	// spot-only, darwin-only; fail-isolated so a sweep bug can never take
	// down the merge/dispatch loop (the wisdom-sweep rule).
	try {
		rogueSweep();
	} catch (e) {
		log(
			`ROGUE sweep failed (fail-isolated): ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 7. reclaim sweep (W376): the `work reclaim all` core per cycle — claims
	// whose claimant is verifiably dead (3 consecutive dead passes, extend
	// lease honored, unknown never releases) release to READY without an
	// operator pass; releases broadcast fleet-wide so dispatch refills them
	// same-cycle. Fail-isolated: a sweep bug can never take down the
	// merge/dispatch loop (the wisdom-sweep rule).
	if (!existsSync(`${REPO}/.fleet/reclaim-paused`)) {
		try {
			reclaimSweep();
		} catch (e) {
			log(
				`RECLAIM sweep failed (fail-isolated): ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// 8. maintenance sweep (W779): the folded no-port launchd agents as
	// typed-task registry — each due task fire is attempt-stamped then
	// spawned as a child (callee decides fan-out); a watchdog-killed cycle
	// never re-fires the same task. Fail-isolated inside runMaintenanceSweep.
	runMaintenanceSweep();
}

// dispatch: one Work Graph item → claimed, worktree, briefed headless lane.
// The fleet's own spawner — the coordinator dispatches a single item; the
// loop's pid guard, lanes verb, and retire lifecycle cover the result.
if (MODE === "dispatch") await runDispatch(config, { log, sh, lanes });

// flush — the ladder as a control-plane step (W641, gap found 2026-10-11):
// the refill tick verifies+closes+dispatches but nothing merges; a paused
// ladder daemon then parks verified work on branches matching the glob until
// a human notices (4 sat ~40 min). One-shot, foreground, tick-invocable:
// merge ONLY branches whose item is DONE and whose result_sha resolves to
// the branch head. Everything else defers loudly. The merge itself is
// mergeOne's fail-isolated path — guardedMerge conflict-refusal,
// strikes→park, work.landed broadcast per flush, retire lifecycle. Never
// auto-resolves: a conflicted branch takes the NEED_DECISION in mergeFail
// and is left for inspection.
if (MODE === "flush") {
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		const live = mergeRunnerAlive();
		if (live) {
			log(`FLUSH-VETO — merge runner pid ${live} mid-flight, flush refused`);
			process.exit(1);
		}
		// W1072.2: hold/mid-op defers the heal — a detached flush must never
		// abort/reset operator merge state (cherry-pick race #55077).
		if (mergeHoldActive(REPO) || gitMidOp(REPO))
			log(
				"MERGE-DEFER flush — merge state + operator hold/mid-op, heal deferred",
			);
		else healCrashedMerge();
	}
	// W249 merge-on-done: --item <id> --await <secs> — the done-verb's detached
	// trigger waits HERE for the closing lane to exit (the alive-lane veto
	// protects live work), then the sweep below merges it; timeout defers
	// loudly, the daemon sweep still owns the branch.
	const doneWait = await flushOnDoneWait(
		REPO,
		val("--item"),
		num("--await", 0),
		laneIsAlive,
		log,
	);
	if (doneWait.exit) process.exit(0);
	let merged = 0;
	let deferred = 0;
	const sweep = new Set(
		sh(["git", "branch", "--list", GLOB, "--format", "%(refname:short)"])
			.split("\n")
			.filter(Boolean),
	);
	if (doneWait.branch) sweep.add(doneWait.branch);
	for (const b of sweep) {
		// W1072.2: ONE shared predicate with mergeOne — DONE + exact result_sha;
		// the sweep's own hold/in-progress gate sits before it so a held checkout
		// defers the whole sweep loudly without touching any branch.
		if (mergeHoldActive(REPO)) {
			log(`FLUSH-DEFER ${b} — operator merge hold (.fleet/merge-hold)`);
			deferred++;
			continue;
		}
		const inprog = gitInProgress(REPO);
		if (inprog) {
			log(`FLUSH-DEFER ${b} — ${inprog}`);
			deferred++;
			continue;
		}
		const claim = itemClaimOf(REPO, b);
		const exact = doneShaResolves(REPO, b, claim);
		if (!exact.ok) {
			log(`FLUSH-DEFER ${b} — ${exact.why}`);
			deferred++;
			continue;
		}
		mergeOne(b);
		merged++;
	}
	log(`FLUSH merged=${merged} deferred=${deferred}`);
	process.exit(0);
}

// ship: one branch through the ladder NOW — the board's one-click ship
// trigger (W64, fleet-board /api/ship). A foreground single-shot of the
// cycle's merge step: same merge-liveness veto + crashed-merge heal, ladder
// timeout, FAIL tail, strike/park discipline, retire lifecycle. The branch
// need not match --glob (explicit intent); the BOARD resolves the ladder
// from the repo's .fleet/ship.json and passes it here — the loop shell
// stays policy-free.
if (MODE === "ship") {
	const b = val("--branch");
	if (!b) {
		console.error("ship requires --branch <branch>");
		process.exit(1);
	}
	// W101 ship-vs-daemon race: same merge-liveness discipline as cycle
	// step 1 — a live daemon ladder is hands-off (a blind abort here killed
	// the daemon's in-flight merge, FAIL-struck the innocent branch, and
	// clobbered the shared .fleet/merge-active marker); crashed debris gets
	// the surgical heal
	const live = mergeRunnerAlive();
	if (live) {
		log(`SHIP-VETO ${b} — merge runner pid ${live} mid-flight, ship refused`);
		console.error(`ship refused: merge runner pid ${live} mid-flight`);
		process.exit(1);
	}
	// never enter with leftover merge state (same as cycle step 1);
	// W1072.2: hold/mid-op defers the heal — operator state is never touched
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		if (mergeHoldActive(REPO) || gitMidOp(REPO))
			log(
				"MERGE-DEFER ship — merge state + operator hold/mid-op, heal deferred",
			);
		else healCrashedMerge();
	}
	if (mergeOne(b) === "missing") {
		console.error(`ship refused: branch ref missing: ${b}`);
		process.exit(1);
	}
	process.exit(0);
}

// lanes: the liveness table from .fleet/lanes.json — who's alive, who died
// without the loop noticing (the check gaps ran ad-hoc after the flip)
if (MODE === "lanes") {
	const rows = lanes();
	if (rows.length === 0) {
		console.log("no lanes in .fleet/lanes.json");
		process.exit(0);
	}
	for (const l of rows) {
		const identity = laneProcessIdentity(l);
		console.log(
			`${identity === true ? "ALIVE" : identity === null ? "unknown" : "dead "}  ${l.item.padEnd(10)} ${l.sid.padEnd(16)} pid ${String(l.pid).padEnd(8)} ${(l.agent ?? "claude").padEnd(7)} ${l.branch}`,
		);
	}
	process.exit(0);
}

// posture: the W911 plaid switch — read shows, an arg writes (steady|plaid).
if (MODE === "posture") {
	const arg = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
	if (arg && !parsePosture(arg)) {
		console.error("usage: fleet-loop posture [steady|plaid] --repo <dir>");
		process.exit(1);
	}
	if (arg) writePosture(`${REPO}/.fleet`, parsePosture(arg));
	const p = readPosture(`${REPO}/.fleet`);
	console.log(
		p === "plaid"
			? "posture: plaid — no fixed lane cap; sequential launches with a 10s default gap while routes are healthy"
			: `posture: steady — loop stop ${postureWidth(p, 6)} lanes (--target 6)`,
	);
	process.exit(0);
}

if (MODE === "once") {
	await cycle();
	process.exit(0);
}

// watch: each cycle is a killable --once child under a watchdog timer.
// W576.5 controller fence: exactly one watch per project acts. Authority is
// a governor lease (pid+birth fenced, generation recorded); a second watch
// STANDBYS — no cycles, no dispatch — while the holder is provably alive,
// takes over only a provably dead holder, and releases authority at this
// idle cycle boundary when the owner requested a handoff (launchd KeepAlive
// respawns the successor; lanes are separate processes, never touched).
log(
	`fleet-loop start pid=${process.pid} repo=${REPO} glob=${GLOB} every=${EVERY_MS / 1000}s watchdog=${CYCLE_TIMEOUT_MS / 60000}min`,
);
const CONTROLLER_NONCE = crypto.randomUUID();
let controllerIdentity: ReturnType<typeof currentControllerIdentity> | null =
	null;
let standbyLogged = false;
while (true) {
	if (!controllerIdentity) {
		try {
			// W641: the fence identity derives from the CALLER's entrypoint —
			// the one-arg call left scriptPath undefined and crash-looped watch
			// at every spawn (CONTROLLER-REFUSED, .fleet/loop.log 2026-10-11),
			// so the ladder never ran a cycle and verified branches sat unmerged
			controllerIdentity = currentControllerIdentity(
				CONTROLLER_NONCE,
				import.meta.path,
			);
		} catch (error) {
			log(
				`CONTROLLER-REFUSED pid=${process.pid} — ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		}
	}
	const fenceStore = openStore();
	const verdict = controllerWatchBoundary(
		fenceStore,
		projectIdentity(REPO),
		controllerIdentity,
	);
	fenceStore.close();
	if (verdict === "standby") {
		if (!standbyLogged) {
			log(
				`CONTROLLER-STANDBY pid=${process.pid} — a provably alive controller holds the authority; standing by, no cycles`,
			);
			standbyLogged = true;
		}
		await Bun.sleep(EVERY_MS);
		continue;
	}
	standbyLogged = false;
	if (verdict === "handoff") {
		log(
			`CONTROLLER-RELEASED pid=${process.pid} — owner-requested handoff released at idle boundary; KeepAlive respawns the successor`,
		);
		process.exit(0);
	}
	const childArgs = argv.slice(1);
	const repoIndex = childArgs.indexOf("--repo");
	if (repoIndex >= 0) childArgs[repoIndex + 1] = CALLER_REPO;
	const child = Bun.spawn(
		[process.execPath, import.meta.path, "once", ...childArgs],
		{ cwd: REPO, stdout: "inherit", stderr: "inherit", stdin: "ignore" },
	);
	const timer = setTimeout(() => {
		log(
			`WATCHDOG killed cycle pid=${child.pid} after ${CYCLE_TIMEOUT_MS / 60000}min — hung spawn/gate`,
		);
		try {
			child.kill(9);
		} catch {}
	}, CYCLE_TIMEOUT_MS);
	await child.exited;
	clearTimeout(timer);
	await Bun.sleep(EVERY_MS);
}
