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
//
// Hardened per the gaps incidents (2026-09-28): cycles run as killable --once
// children under a watchdog (a hung spawnSync froze the gaps daemon 26h);
// FAIL lines carry the ladder's last 3 output lines (a pnpm-ENOENT cascade
// was invisible for an hour); 3-strike PARK; live-lane pid guard on retire;
// MERGE_HEAD abort, never reset --hard on a shared checkout.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { hostname } from "node:os";
import { symlinkBuildDirs } from "../lib/builddirs.ts";
import { retireLaneKey } from "../../scripts/lib/lane-auth.ts";
import { launchParent } from "../../scripts/lib/launch-parent.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
	readLaneRegistry,
	mergeLaneRegistry,
	safeToRetire,
	retirementProcessLive,
} from "../lib/lane-registry.ts";
import { openStore, openGovernorDb, projectIdentity } from "../lib/govdb.ts";
// W177: lane resource caps live with the other spawn plumbing (lane.ts);
// the dispatch verb's inline recipe embeds the same jobslab preamble.
import {
	jobslabFor,
	jobslabPrefix,
	jobslabTag,
	laneClassOf,
} from "../../scripts/lib/jobslab.ts";
import { resolve } from "node:path";
import { laneSid } from "../lib/laneslug.ts";
import {
	observeDeadClaim,
	attemptRecovery,
	recordRecoveryResult,
	type DeadEpisode,
} from "../lib/dead-claim-recovery.ts";
import {
	laneAlive,
	laneProcessIdentity,
	transcriptAlive,
} from "../lib/lane-liveness.ts";
import { condensePrompt } from "../board/prompt-transform.ts";
import { wisdomSweep } from "../coord/wisdom.ts";
import { flagIntegratedCode } from "../lib/decomposition.ts";
import {
	acquireLaunchLease,
	releaseLaunchLease,
	resolveLaneExecutor,
	releaseFailedLaunch,
} from "../../scripts/lib/launch-preflight.ts";
import {
	launchIntent,
	inspectLaunchIntent,
	nextReservedAttempt,
	reserveLaunchIntent,
	fencedExecutor,
	awaitLaunchRegistration,
	assertLaunchClaim,
	terminateOwnLaunch,
	finishFailedLaunch,
	type LaunchIntent,
} from "../../scripts/lib/launch-fencing.ts";
import { laneAttemptLimit } from "../../scripts/lib/lane-retry-budget.ts";
import {
	canonicalWorkClaim,
	canonicalWorkReclaim,
} from "../../scripts/lib/work-inspection.ts";
import { isResumableClaim } from "../../scripts/lib/resumable-claim.ts";
import { guardedMerge } from "../lib/merge-guard.ts";
import {
	CliError,
	type CommandDef,
	helpOf,
	parseCommand,
} from "../lib/cli.ts";

const argv = process.argv.slice(2);
// declarative spec via the shared arg/cmd toolkit (hooks/lib/cli.ts) —
// unknown flags now die with the usage (they were silently ignored before
// W421); numeric flags validate at access time
const MODES = ["once", "watch", "lanes", "dispatch", "ship"];
const SPEC: CommandDef = {
	name: "fleet-loop",
	usage:
		`usage: fleet-loop once|watch|lanes|dispatch|ship --repo <dir> [--glob lane/autow*] [--main main]\n` +
		`          [--ladder <cmd template with {branch}>]  default: plain git merge --no-ff\n` +
		`          [--ladder-timeout 10]                    minutes; watchdog-kills a hung ladder\n` +
		`          [--dispatch-cmd <template>]              optional policy script\n` +
		`          [--agent claude|codex]                   dispatch backend (default claude)\n` +
		`          ship --branch <branch>                   one branch through the ladder (board ship trigger)\n` +
		`          [--every 120] [--cycle-timeout 15] [--log <file>]   (watch mode)`,
	flags: {
		"--repo": { required: true },
		"--glob": {},
		"--main": {},
		"--ladder": {},
		"--agent": {},
		"--effort": {},
		"--dispatch-cmd": {},
		"--log": {},
		"--item": {},
		"--branch": {},
		"--target": {},
		"--stall-warn-min": {},
		"--ladder-timeout": {},
		"--every": {},
		"--cycle-timeout": {},
	},
	minPos: 1,
};
const parsed = (() => {
	try {
		return parseCommand(SPEC, argv);
	} catch (e) {
		if (e instanceof CliError) {
			console.error(e.message);
			process.exit(2);
		}
		throw e;
	}
})();
if (parsed.help) {
	console.log(helpOf(SPEC));
	process.exit(0);
}
const MODE = parsed.pos[0];
if (!MODE) {
	console.error(SPEC.usage);
	process.exit(0); // bare fleet-loop: usage text, exit 0 (as before W421)
}
if (!MODES.includes(MODE)) {
	console.error(SPEC.usage);
	process.exit(1);
}
// thin wrappers over the toolkit parse result — downstream call sites
// (config consts below, ship/cycle reads) keep their old shape
const val = (flag: string, dflt?: string): string | undefined =>
	parsed.flag(flag) ?? dflt;
const num = (flag: string, dflt: number): number => {
	try {
		return parsed.num(flag, dflt);
	} catch (e) {
		if (e instanceof CliError) {
			console.error(e.message);
			process.exit(2);
		}
		throw e;
	}
};

const requestedRepo = val("--repo");
const CALLER_REPO = resolve(requestedRepo ?? "");
const REPO = canonicalProjectRoot(CALLER_REPO);
const MAIN = val("--main", "main");
const GLOB = val("--glob", "lane/autow*");
const LADDER = val("--ladder");
const AGENT = val("--agent", "claude");
const EFFORT = val("--effort"); // W183.1 — copilot --reasoning-effort passthrough
const LADDER_TIMEOUT_MS = num("--ladder-timeout", 10) * 60_000;
const DISPATCH = val("--dispatch-cmd");
const EVERY_MS = num("--every", 120) * 1000;
const CYCLE_TIMEOUT_MS = num("--cycle-timeout", 15) * 60_000;
const LOG = val("--log", `${REPO}/.fleet/loop.log`);
const FAILS = `${REPO}/.fleet/merge-fails.json`;

const log = (msg: string): void => {
	const line = `${new Date().toISOString()} ${msg}\n`;
	try {
		appendFileSync(LOG, line);
	} catch {
		try {
			mkdirSync(LOG.replace(/\/[^/]+$/, ""), { recursive: true });
			appendFileSync(LOG, line);
		} catch {}
	}
};

const sh = (cmd: string[]): string => {
	const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};
const run = (cmd: string[]): number =>
	Bun.spawnSync(cmd, { cwd: REPO, stdout: "ignore", stderr: "ignore" })
		.exitCode ?? 1;

type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	launchedAt?: number;
	host?: string;
};

function readJsonSync<T>(p: string): T | null {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

const lanes = (): Lane[] => loadLaneRegistry<Lane>(REPO);
const readFails = (): Record<string, number> => readJsonSync(FAILS) ?? {};
const writeFails = (o: Record<string, number>): void => {
	try {
		writeFileSync(FAILS, JSON.stringify(o));
	} catch {}
};
const bumpFail = (b: string): number => {
	const o = readFails();
	o[b] = (o[b] ?? 0) + 1;
	writeFails(o);
	return o[b];
};
const clearFail = (b: string): void => {
	const o = readFails();
	if (o[b] === undefined) return;
	delete o[b];
	writeFails(o);
};

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

const ahead = (b: string): number => {
	// a failed rev-list (unknown ref, park-rename race) must read as
	// UNMERGED, never as merged — Number("") was 0, which made any vanished
	// branch look fully merged to the retire path (2026-09-28 gaps losses)
	const out = sh(["git", "rev-list", "--count", `${MAIN}..${b}`]);
	const n = Number(out);
	return out !== "" && Number.isFinite(n) ? n : -1;
};

// retire's runs capture stderr — a RETIRE-BLOCKED line must carry git's
// reason (the loop's own "reasonless FAIL is a bug" doctrine)
const runCap = (cmd: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

/** Actual worktree path checked out at branch b, from git's registry —
 *  gaps parks lanes under .claude/worktrees/ (not .worktrees/), so the
 *  default-path guess misses them and branch delete stalls on "used by
 *  worktree" (autow294.1, 2026-09-28). */
function wtPathFromGit(b: string): string | null {
	const out = sh(["git", "worktree", "list", "--porcelain"]);
	let path: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch ")) {
			if (line.slice("branch ".length).trim() === `refs/heads/${b}` && path)
				return path;
		}
	}
	return null;
}

/** liveness = THE surface's verdict (hooks/lib/lane-liveness.ts) for tracked
 * lanes; untracked branches keep the worktree-cwd probe as EVIDENCE for this
 * sweep (W494.1: cwd is evidence, never a liveness term). Survives the
 * unregistered spawn window and DISPATCHED-less dispatchers. */
function laneIsAlive(b: string): boolean | null {
	// W494.1: tracked lanes ask THE surface (work lanes verdict — shared with
	// dispatch-next); untracked branches keep the worktree evidence probe
	const tracked = lanes().find((l) => l.branch === b);
	if (tracked && laneAlive(tracked)) return true;
	if (tracked && laneProcessIdentity(tracked) === null) return null;
	const wt = wtPathFromGit(b) ?? `${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
	return retirementProcessLive(wt);
}

function retireMerged(b: string): void {
	// kill switch (gaps 2026-09-30: live lanes retired ~90s after dispatch —
	// marker contract drift vs their new dispatcher). Touch
	// .fleet/retires-paused to pause ALL retires; delete the file to resume.
	if (existsSync(`${REPO}/.fleet/retires-paused`)) return;
	if (ahead(b) !== 0) return;
	const registry = readLaneRegistry<Lane>(REPO);
	if (!registry.known) {
		log(`RETIRE-BLOCKED ${b} — registry unknown: ${registry.error}`);
		return;
	}
	const entry = registry.lanes.find((row) => row.branch === b);
	const item = entry?.item ?? b.split("/").at(-1);
	let claimKnown = false,
		claimed = false;
	try {
		const store = openStore();
		try {
			const claim = store
				.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
				.get(projectIdentity(REPO), item) as { state: string } | undefined;
			claimKnown =
				!claim ||
				[
					"READY",
					"CLAIMED",
					"RUNNING",
					"DONE",
					"FAILED",
					"BLOCKED",
					"SHATTERED",
					"SUPERSEDED",
					"PAUSED",
					"CANCELLED",
				].includes(claim.state);
			claimed = !!claim && ["CLAIMED", "RUNNING"].includes(claim.state);
		} finally {
			store.close();
		}
	} catch {}
	if (
		!safeToRetire({
			registryKnown: registry.known,
			claimKnown,
			claimed,
			recentlyLaunched:
				!!entry && Date.now() - (entry.launchedAt ?? 0) < 10 * 60_000,
			live: laneIsAlive(b),
		})
	)
		return;

	// ahead=0 is also true for a freshly-dispatched lane's pre-commit branch —
	// never retire a branch a LIVE lane still owns. Tracked-pid alone raced
	// gaps' dispatch-next (registers lanes.json async, writes no DISPATCHED
	// lines) — liveness is now tracked pid OR any live supported-agent process
	// whose cwd is inside the worktree (gaps 2026-09-30 incident; W309 widened
	// the process match beyond claude/codex)
	const tracked = lanes().find((l) => l.branch === b);
	// worktree path: git's registry is ground truth — gaps parks lanes under
	// .claude/worktrees/ (not .worktrees/), so the bare default guess misses
	// them and branch delete stalls on "used by worktree"
	const wt =
		wtPathFromGit(b) ??
		tracked?.worktree ??
		`${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
	// mid-spawn grace (2026-09-28 gaps autow298/299): dispatch registers the
	// branch immediately but gaps' async wrapper lands the lanes.json entry
	// 22–55s later — the ladder saw ahead=0 with NO entry, the pid guard had
	// nothing to check, and retire fired on a lane mid-spawn.
	if (!tracked) {
		// evidence of a recent dispatch → skip (unregistered spawn window)
		try {
			const line = readFileSync(`${REPO}/.fleet/loop.log`, "utf8")
				.split("\n")
				.reverse()
				.find((l) => l.includes("DISPATCHED") && l.includes(b));
			const ts = line ? Date.parse(line.slice(0, 24)) : Number.NaN;
			if (Number.isFinite(ts) && Date.now() - ts < 10 * 60_000) return;
		} catch {}
		// gaps 2026-09-30: dispatch-next writes NO DISPATCHED lines, so
		// "no evidence" is the norm, not a signal — a seconds-old worktree is
		// the pre-spawn window, not debris. Skip while young; genuine debris
		// (laneIsAlive already confirmed nothing runs in it) retires once aged.
		// FLEET_UNTRACKED_GRACE_MS=0 fast-forwards the grace (tests, manual
		// debris cleanup).
		try {
			if (
				Date.now() - statSync(wt).birthtimeMs <
				Number(process.env.FLEET_UNTRACKED_GRACE_MS ?? 120_000)
			)
				return;
		} catch {}
	}
	// REFERENCE BEFORE DELETE (gaps incident 2026-09-28): pin the tip to a
	// recovery ref before any destructive step, so a later -D or an
	// aggressive prune can never orphan the commits.
	const tip = sh(["git", "rev-parse", "--verify", b]);
	if (tip)
		runCap([
			"git",
			"update-ref",
			`refs/recover/${b.replace(/\//g, "-")}-${Date.now()}`,
			tip,
		]);
	if (existsSync(wt)) {
		let rm = runCap(["git", "worktree", "remove", "--force", wt]);
		if (rm.code !== 0) {
			// stale worktree registration (git's metadata outlived a dead lane) —
			// prune and retry once; a second failure is logged with git's reason
			runCap(["git", "worktree", "prune"]);
			rm = runCap(["git", "worktree", "remove", "--force", wt]);
		}
		if (rm.code !== 0)
			log(
				`RETIRE-STALL ${b} — worktree remove failed: ${rm.out.split("\n").slice(-2).join(" | ")}`,
			);
	}
	const delD = runCap(["git", "branch", "-d", b]);
	const del = delD.code === 0 ? null : runCap(["git", "branch", "-D", b]);
	if (delD.code === 0 || (del && del.code === 0)) log(`RETIRED ${b}`);
	else
		log(
			`RETIRE-BLOCKED ${b} — branch delete failed: ${del ? del.out.split("\n").slice(-2).join(" | ") : "?"}`,
		);
	// W463 lane-key lifecycle: the same point that knows the lane ended
	// revokes its buckle key and deletes the per-lane files — no new daemon.
	// Fire-and-forget: this path is sync; the fetch keeps the process warm
	// until the revoke settles, and the loop.log line lands in .then.
	if (tracked)
		void retireLaneKey({ fleet: `${REPO}/.fleet`, sid: tracked.sid })
			.then((rk) => {
				if (rk.keyId)
					log(
						`LANE-KEY ${tracked.sid} — key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke failed (24h TTL bounds it)"}`,
					);
			})
			.catch(() => {});
}

// A rejected isolated ladder: preserve shared main, count the strike, park at 3.
function mergeFail(b: string, tail: string): void {
	// guardedMerge cleans only its owned scratch worktree. Never abort an
	// unrelated merge another runner may have begun in the shared checkout.
	log(
		`FAIL ${b} — isolated ladder rejected, shared checkout preserved, branch left for inspection${tail ? `: ${tail}` : ""}`,
	);
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', 'BROADCAST', ?, ?, NULL)",
			)
			.run(
				Date.now(),
				b,
				JSON.stringify({
					project: projectIdentity(REPO),
					note: `Merge rejected for ${b}: ${tail || "ladder failure"}; branch preserved for inspection.`,
				}),
			);
	} catch {
		/* rejection remains recorded in loop.log if the bus is unavailable */
	}
	const n = bumpFail(b);
	if (n >= 3) {
		const parked = b.replace(/^([^/]+)\//, "parked/");
		run(["git", "branch", "-m", b, parked]);
		log(
			`PARKED ${b} → ${parked} after ${n} failed ladder attempts — needs a repair lane`,
		);
		clearFail(b);
	}
}

// one branch through the ladder — the cycle's per-branch body, shared with
// the board's one-click ship (`ship --branch <b>` runs it foreground).
// Fail-isolated: a failed ladder aborts the merge, leaves the branch for
// inspection, and counts toward the 3-strike park like every other merge.
function mergeOne(b: string): void {
	const n = ahead(b);
	if (n < 0) return; // vanished between sweep and ladder (park-rename race)
	if (n === 0) {
		retireMerged(b);
		return;
	}
	// never merge a branch a live lane still owns (gaps 2026-09-30: autow351
	// was merged mid-flight with 3 live pids in its worktree — the ladder
	// treated ahead>0 as ready and its retire swept the worktree out from
	// under the agents)
	if (laneIsAlive(b)) return;
	// W101: a live .fleet/merge-active marker means another runner is
	// mid-ladder (the marker is written BEFORE the merge starts, so it can
	// be live with no MERGE_HEAD yet) — never start a second ladder over
	// it; the next cycle or ship run retries once the runner finishes
	const liveRunner = mergeRunnerAlive();
	if (liveRunner) {
		log(`MERGE-BUSY ${b} — runner pid ${liveRunner} mid-flight, skipped`);
		return;
	}
	// liveness marker: a crash between --no-commit and commit leaves
	// MERGE_HEAD + staged debris that plain merge --abort cannot clear (the
	// 2026-09-28 gaps stall). The marker tells the next cycle whether a
	// merge runner is genuinely alive or the state is debris.
	const marker = `${REPO}/.fleet/merge-active`;
	// ship mode on a fresh repo has no .fleet/ yet (watch always did) — W64
	// tests caught the ENOENT (2026-09-29)
	mkdirSync(`${REPO}/.fleet`, { recursive: true });
	writeFileSync(
		marker,
		JSON.stringify({
			pid: process.pid,
			// exact-identity check: a recycled pid must also carry the runner's
			// own command line to count as live (gaps 18517f51 follow-up)
			cmd: process.argv.join(" "),
			branch: b,
			ts: Date.now(),
		}),
	);
	const before = sh(["git", "rev-parse", "--short", "HEAD"]);
	const mv = guardedMerge({
		repo: REPO,
		callerRepo: CALLER_REPO,
		branch: b,
		ladder: LADDER,
		timeoutMs: LADDER_TIMEOUT_MS,
	});
	if (mv.code === 0) {
		const after = sh(["git", "rev-parse", "--short", "HEAD"]);
		log(`MERGED ${b} ${before}→${after}`);
		try {
			for (const file of flagIntegratedCode({
				repo: REPO,
				before,
				after,
				source: "fleet-loop",
			}))
				log(
					`DECOMPOSITION ${file.path}: ${file.lines} lines — queued DRY and imported-module decomposition`,
				);
		} catch (error) {
			log(
				`DECOMPOSITION-CHECK-FAILED ${b}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// work.landed on the bus: waiting lanes use `coord wait --kinds
		// work.landed --scope <item>` instead of /tmp poll scripts
		try {
			openGovernorDb()
				.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', 'work.landed', ?, ?, NULL)",
				)
				.run(Date.now(), b, JSON.stringify({ work: b, sha: after }));
		} catch {}
		clearFail(b);
	} else {
		mergeFail(b, mv.tail);
	}
	try {
		rmSync(`${REPO}/.fleet/merge-active`);
	} catch {}
	retireMerged(b);
}

/** pid of a live merge runner, or null. A stale marker (dead pid, or older
 * than 30 min — a watchdog-killed runner whose unlink never ran) reads as
 * debris. */
function mergeRunnerAlive(): number | null {
	try {
		const j = JSON.parse(
			readFileSync(`${REPO}/.fleet/merge-active`, "utf8"),
		) as { pid: number; cmd?: string; ts: number };
		if (Date.now() - j.ts > 30 * 60_000) return null;
		process.kill(j.pid, 0);
		// kill(pid,0) is forgeable — a recycled pid is "alive" but is not the
		// merge runner; the marker must carry the runner's exact command line
		// and the process must still match it (gaps 18517f51 follow-up).
		// Markers without cmd predate the identity check → never trusted.
		if (!j.cmd) return null;
		const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(j.pid)])
			.stdout.toString()
			.trim();
		if (cmd !== j.cmd) return null;
		return j.pid;
	} catch {
		return null;
	}
}

// ─── stall watchdog (the autow428 lesson, 2026-10-05) ────────────────────
// A lane can hang or die silently with its claim held — pid-alive, zero
// activity. The graph reclaims dead claims at hb expiry; the watchdog's
// job is the EARLIER verdict: a tracked, pid-alive lane with no log or
// worktree activity for STALL_WARN_MS gets ONE lane.stalled broadcast per
// episode (state in .fleet/stall.json — survives loop restarts), cleared
// with lane.resumed when activity returns. Dead claims remain held pending
// explicit recovery; automatic bulk reclaim cannot establish safe ownership.
const STALL_FILE = `${REPO}/.fleet/stall.json`;
const DEAD_FILE = `${REPO}/.fleet/dead-recovery.json`;
const STALL_WARN_MS = num("--stall-warn-min", 10) * 60_000;
type StallState = Record<string, { since: number; warned: boolean }>;

// newest file mtime walk, .git excluded, 6 levels deep — the activity
// signal a frozen lane cannot fake: a working lane writes files.
function newestFileMtime(dir: string, depth = 0): number | null {
	let newest: number | null = null;
	let ents: Dirent[];
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of ents) {
		if (
			[
				".git",
				".fleet",
				".claude",
				"node_modules",
				".klh-brief.md",
				".workgraph.jsonl",
			].includes(e.name)
		)
			continue;
		const p = `${dir}/${e.name}`;
		if (e.isDirectory()) {
			if (e.name === ".git" || depth >= 6) continue;
			const m = newestFileMtime(p, depth + 1);
			if (m !== null && (newest === null || m > newest)) newest = m;
		} else {
			try {
				const m = statSync(p).mtimeMs;
				if (newest === null || m > newest) newest = m;
			} catch {}
		}
	}
	return newest;
}

// one lane.stalled event per episode, one lane.resumed on recovery — the
// graph's events table is the broadcast plane (same idiom as work.landed).
function emitLaneEvent(kind: string, item: string, payload: object): void {
	try {
		openStore()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', ?, ?, ?, NULL)",
			)
			.run(Date.now(), kind, item, JSON.stringify(payload));
	} catch {}
}

function stallWatch(): void {
	const now = Date.now();
	const state: StallState = readJsonSync(STALL_FILE) ?? {};
	const dead: Record<string, DeadEpisode> = readJsonSync(DEAD_FILE) ?? {};
	const project = projectIdentity(REPO);
	const seen = new Set<string>();
	for (const l of lanes()) {
		const claim = canonicalWorkClaim(
			REPO,
			l.item,
			project,
			`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
		);
		if (!claim) {
			delete dead[JSON.stringify([project, l.item])];
			continue;
		}

		if (
			claim.project !== project ||
			claim.id !== l.item ||
			typeof claim.updated_at !== "number" ||
			claim.owner_sid !== l.sid ||
			!["CLAIMED", "RUNNING"].includes(claim.state ?? "")
		) {
			delete dead[JSON.stringify([project, l.item])];
			continue;
		}
		seen.add(l.sid);
		const key = JSON.stringify([project, l.item]);
		const observation = observeDeadClaim(dead[key], {
			lane: l,
			localHost: hostname(),
			owner: l.sid,
			revision: claim.updated_at,
			identity: laneProcessIdentity(l),
			transcriptFresh: transcriptAlive(l.sid),
			now,
		});
		dead[key] = observation.episode;
		if (observation.action !== "live") {
			if (observation.action === "quarantine") {
				let recovery: "released" | "held" | "exhausted" = "held";
				try {
					recovery = attemptRecovery(
						openStore(),
						{ project, id: l.item, owner: l.sid, revision: claim.updated_at },
						() =>
							l.host === hostname() &&
							laneProcessIdentity(l) === false &&
							!transcriptAlive(l.sid),
						() =>
							canonicalWorkReclaim(
								REPO,
								{
									project,
									id: l.item,
									owner: l.sid,
									revision: claim.updated_at,
								},
								`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
							),
						() =>
							canonicalWorkClaim(
								REPO,
								l.item,
								project,
								`${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin/work.ts`,
							) ?? {},
					);
				} catch {
					/* authoritative failure holds ownership; no local fallback */
				}
				if (recovery === "released") {
					delete dead[key];
					emitLaneEvent("lane.reclaimed", l.item, {
						project,
						sid: l.sid,
						previousUpdatedAt: claim.updated_at,
					});
					log(
						`RECLAIM ${l.sid} on ${l.item} — exact scoped receipt and READY state verified`,
					);
				} else if (recordRecoveryResult(observation.episode, recovery)) {
					log(
						`RECOVERY-HELD ${l.sid} on ${l.item} — ${recovery}; operator decision required`,
					);
					emitLaneEvent("NEED_DECISION", l.item, {
						project,
						sid: l.sid,
						reason: `automatic recovery ${recovery}; inspect identity/claim/budget before explicit reset`,
					});
				}
			} else if (observation.notify) {
				log(
					`DEAD ${l.sid} on ${l.item} — exact local identity absent; observation grace started`,
				);
				emitLaneEvent("lane.dead", l.item, { project, sid: l.sid });
			}
			continue;
		}
		const activity =
			(l.worktree ? newestFileMtime(l.worktree) : null) ??
			l.launchedAt ??
			state[l.sid]?.since ??
			now;
		watchLane(state, seen, l, now, activity);
	}
	for (const sid of Object.keys(state)) if (!seen.has(sid)) delete state[sid];
	writeFileSync(STALL_FILE, JSON.stringify(state));
	writeFileSync(DEAD_FILE, JSON.stringify(dead), { mode: 0o600 });
}

// per-lane episode bookkeeping, split from stallWatch for the mutation gate
function watchLane(
	state: StallState,
	_seen: Set<string>,
	l: Lane,
	now: number,
	activity: number,
): void {
	if (now - activity < STALL_WARN_MS) {
		if (state[l.sid]?.warned)
			emitLaneEvent("lane.resumed", l.item, { sid: l.sid });
		delete state[l.sid];
		return;
	}
	if (!state[l.sid]) state[l.sid] = { since: activity, warned: false };
	if (state[l.sid].warned) return;
	state[l.sid].warned = true;
	log(
		`STALLED ${l.sid} on ${l.item} — product artifacts unchanged ${Math.round((now - activity) / 60000)}m`,
	);
	emitLaneEvent("lane.stalled", l.item, {
		sid: l.sid,
		stallMs: now - activity,
	});
}

async function cycle(): Promise<void> {
	// 1. never enter a cycle with leftover merge state. MERGE_HEAD is either
	// a LIVE merge (another runner mid-flight — hands off) or crashed-run
	// debris (heal: surgical abort, guarded reset as last resort).
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		const live = mergeRunnerAlive();
		if (live) log(`MERGE in progress by pid ${live} — cycle leaves it alone`);
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
}

/** Recover a crashed merge: a dead runner left MERGE_HEAD + staged debris.
 * SURGICAL FIRST — restore only STAGED paths (index column of porcelain) to
 * the index, which is what blocks merge --abort; unstaged paths may be a
 * bystander session's WIP and are never touched. Guarded reset --hard is
 * the last resort, loud, and only when no live runner exists. */
function healCrashedMerge(): void {
	const head = sh(["git", "rev-parse", "--short", "MERGE_HEAD"]) || "?";
	const branch = sh(["git", "name-rev", "--name-only", "MERGE_HEAD"]) || head;
	const staged = sh(["git", "status", "--porcelain"])
		.split("\n")
		.filter((l) => l.length > 3 && l[0] !== " " && l[0] !== "?")
		.map((l) => l.slice(3).trim());
	if (staged.length)
		run([
			"git",
			"checkout",
			"--",
			...staged.map((p) => p.split(" -> ").pop() ?? p),
		]);
	const ab = runCap(["git", "merge", "--abort"]);
	if (ab.code === 0) {
		// POST-CONDITION (gaps 18517f51): a bare commit in the healed state
		// must not be able to conclude anything — MERGE_HEAD gone AND the
		// index clean. checkout -- restores the worktree FROM the index and
		// leaves entries staged, so verify and sweep any remnant with a
		// mixed reset (index only; worktree untouched).
		const left = sh(["git", "status", "--porcelain"])
			.split("\n")
			.filter((l) => l.length > 3 && l[0] !== " " && l[0] !== "?");
		if (left.length > 0 || existsSync(`${REPO}/.git/MERGE_HEAD`)) {
			run(["git", "reset"]);
			log(
				`SELF-HEAL crashed merge of ${branch} (${head}): aborted, ${left.length} staged remnant(s) cleared via mixed reset`,
			);
			return;
		}
		log(
			`SELF-HEAL crashed merge of ${branch} (${head}): restored ${staged.length} path(s) from index to worktree, aborted clean, index verified empty`,
		);
		return;
	}
	run(["git", "reset", "--hard"]);
	log(
		`SELF-HEAL crashed merge of ${branch} (${head}): surgical abort failed (${ab.out.slice(0, 120)}), discarded staged debris via guarded reset --hard`,
	);
}

// dispatch: one Work Graph item → claimed, worktree, briefed headless lane.
// The fleet's own spawner — the coordinator dispatches a single item; the
// loop's pid guard, lanes verb, and retire lifecycle cover the result.
if (MODE === "dispatch") {
	const item = val("--item");
	if (!item) {
		console.error("dispatch requires --item <Wn>");
		process.exit(1);
	}
	if (AGENT !== "claude" && AGENT !== "codex") {
		console.error("dispatch --agent must be claude or codex");
		process.exit(1);
	}
	const sid =
		lanes().find((lane) => lane.item === item)?.sid ??
		laneSid(item, projectIdentity(REPO));
	const wt = `${REPO}/.worktrees/${item}`;
	// live-lane guard: a running lane still owns its worktree — refuse. An
	// existing worktree with NO live lane is reused (resume path).
	const live = lanes().find((l) => l.sid === sid);
	if (live?.pid) {
		const identity = laneProcessIdentity(live);
		if (identity !== false) {
			console.error(
				identity === true
					? `lane ${sid} already running (pid ${live.pid})`
					: `lane ${sid} process identity unknown; refusing duplicate dispatch`,
			);
			process.exit(1);
		}
	}
	const runTool = (args: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync([process.execPath, ...args], {
			cwd: REPO,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
		};
	};
	const bin = resolveLaneExecutor(AGENT);
	if (!bin) {
		console.error(
			`${AGENT} binary not found or configured executor unavailable`,
		);
		process.exit(1);
	}
	const store = openStore(),
		project = projectIdentity(REPO),
		nonce = crypto.randomUUID();
	let revision: number | undefined,
		intent: LaunchIntent | undefined,
		proc: Bun.Subprocess | undefined,
		accepted = false;
	if (!acquireLaunchLease(store, project, sid, nonce)) {
		console.error("another dispatcher owns launch lease");
		process.exit(1);
	}
	try {
		const prior = launchIntent(store, project, item);
		if (prior && inspectLaunchIntent(prior) !== "dead")
			throw new Error("durable launch intent alive or uncertain");
		const published = lanes().find((l) => l.sid === sid);
		if (published && laneProcessIdentity(published) !== false)
			throw new Error("published lane identity alive or uncertain");
		const limit = laneAttemptLimit(process.env.SUSPENDERS_LANE_MAX_ATTEMPTS);
		const attempt = nextReservedAttempt(store, project, item, 0, sid);
		if (attempt >= limit)
			throw new Error("item launch budget exhausted; operator review required");
		const take = runTool([
			`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
			"take",
			item,
			"--as",
			sid,
			"--origin",
			`${hostname()}:${AGENT}`,
		]);
		if (take.code !== 0) {
			const mine = runTool([
				`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
				"show",
				item,
				"--json",
			]);
			if (mine.code !== 0 || !isResumableClaim(mine.out, item, sid)) {
				console.error(`work take failed and not ours: ${take.out}`);
				throw new Error("direct launch preparation failed");
			} // claimed by us from a previous dispatch attempt — resume
		}
		const claim = store
			.query(
				"SELECT updated_at FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
			)
			.get(project, item, sid) as { updated_at: number } | null;
		if (!claim) throw new Error("claim changed during direct launch");
		revision = claim.updated_at;
		intent = reserveLaunchIntent(
			store,
			{ project, item, sid, nonce, revision, executor: bin },
			limit,
			attempt - 1,
		);

		// reuse path: an existing worktree (dead lane's leftover) is used as-is —
		// only a missing one is created. Codex workspaces are NOT git worktrees:
		// a plain dir whose .git file points at the private store (see below).
		if (!existsSync(wt)) {
			if (AGENT === "codex") {
				mkdirSync(wt, { recursive: true });
				// build dirs symlinked from the repo root — parity with worktree.ts
				// create, so codex lanes skip reinstalls too
				symlinkBuildDirs(REPO, wt);
			} else {
				const wtree = runTool([
					`${process.env.HOME}/.claude/hooks/suspenders/bin/worktree.ts`,
					"create",
					item,
				]);
				if (wtree.code !== 0) {
					console.error(`worktree create failed: ${wtree.out}`);
					throw new Error("direct launch preparation failed");
				}
			}
		}
		const branch =
			Bun.spawnSync(["git", "-C", wt, "branch", "--show-current"], {
				cwd: REPO,
				stdout: "pipe",
			})
				.stdout?.toString()
				.trim() || `suspenders/${item}`;
		if (AGENT !== "codex") {
			const parentSid = launchParent(store, project, item);
			const registered = runTool([
				`${process.env.HOME}/.claude/hooks/suspenders/bin/coord.ts`,
				"bootstrap",
				"--as",
				sid,
				"--worktree",
				wt,
				...(parentSid ? ["--parent", parentSid] : []),
			]);
			if (registered.code !== 0)
				throw new Error("lane session metadata registration failed");
		}
		const show = runTool([
			`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
			"show",
			item,
		]);
		// mechanical, not advisory: a one-shot lane only gets one mission read
		// before it starts acting, so anything pending (fleet broadcast, a
		// consult addressed to it before it even existed) must already be in
		// the brief text — the DB query is sub-ms, no reason to gate it behind
		// the lane remembering to run `coord inbox` itself.
		const inboxAtDispatch = runTool([
			`${process.env.HOME}/.claude/hooks/suspenders/bin/coord.ts`,
			"inbox",
			"--as",
			sid,
		]).out;
		// W304.1 — deterministic condense (W270 prose-only ruleset) on the free-text
		// portions of the brief; code fences/paths/flags are protected verbatim by
		// condensePrompt itself, so mission/inbox prose shrinks without losing the
		// technical surface the lane actually has to act on.
		const brief = [
			`You are lane "${sid}", Work Graph item ${item}, repo ${REPO}.`,
			``,
			`MISSION (from work show):`,
			condensePrompt(show.out),
			``,
			`INBOX AT DISPATCH (coordinator/board messages pending for you — already pulled, no need to re-fetch):`,
			inboxAtDispatch ? condensePrompt(inboxAtDispatch) : "(empty)",
			``,
			`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
			`Inbox: check again before finishing — coordinator and board messages still arrive after dispatch: bun ~/.claude/hooks/suspenders/bin/coord.ts inbox --as ${sid}.`,
			`Work in the EXISTING worktree ${wt} (branch ${branch}).`,
			`Finish: bun ~/.claude/hooks/suspenders/bin/work.ts done ${item} --sha <branch-head>.`,
			`Final line: DONE <sha> | SPLIT ${item} | BLOCKED (after 3 honest attempts, tree restored).`,
		].join("\n");
		mkdirSync(`${REPO}/.fleet`, { recursive: true });
		const briefFile = `${REPO}/.fleet/brief-${sid}.md`;
		writeFileSync(briefFile, brief);
		// W432 (mirrors dispatch-next W.F1): sandboxed lanes read NOTHING outside
		// their worktree (lesson.brief-sandbox-access), so the readable copy lands
		// in the worktree and the prompt points there; the .fleet copy stays
		// canonical for the coordinator/board.
		writeFileSync(`${wt}/.klh-brief.md`, brief);
		const env = { ...process.env };
		delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
		if (AGENT !== "codex") {
			env.SUSPENDERS_SID = sid;
			env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL = "canonical-v1";
		}
		delete env.ANTHROPIC_BASE_URL;
		delete env.ANTHROPIC_AUTH_TOKEN;
		// model overrides must not ride the coordinator's env into lanes — a
		// dispatch from a GLM-routed shell hung W57 at model init
		// (claude-code:unrecognized_model, 2026-09-28)
		delete env.ANTHROPIC_MODEL;
		delete env.ANTHROPIC_SMALL_FAST_MODEL;
		// the DEFAULT_*_MODEL trio joined the scrub 2026-09-29: a board launched
		// from a GLM-routed shell passed them into lanes, which failed model init
		delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
		delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		if (AGENT === "codex") {
			env.GIT_DIR = `${wt}/.gitstore`;
			env.GIT_WORK_TREE = wt;
			// W73: the fleet sid rides the lane env — hooks inherit it, making
			// SUSPENDERS_SID the primary identity channel for the codex adapter
			// (ppid-walk into lanes.json stays the fallback, lib/fleetlane.ts).
			env.SUSPENDERS_SID = sid;
		} else if (AGENT === "copilot" || AGENT === "grok" || AGENT === "cline") {
			// W296: same identity-channel parity as codex above, minus the
			// seatbelt-driven private git store workaround — these dialects use
			// normal worktrees, so only the sid needs to ride the lane env.
			env.SUSPENDERS_SID = sid;
		}
		// W432: same rule as dispatch-next — the lane prompt points at the
		// READABLE worktree copy, not the canonical .fleet path lanes can't read.
		const prompt = `Lane ${sid}. Read ${wt}/.klh-brief.md (your readable worktree copy of the mission brief — canonical: ${briefFile}) and execute it fully.`;
		// the agent binary resolves at dispatch time — a bare name ENOENTs under
		// launchd, where PATH is minimal
		// W73/W296 gate wiring: idempotent merge-not-clobber into each CLI's own
		// hook config, right before the lane starts, after the binary check (a
		// missing binary must fail dispatch with its own error, not a wiring
		// one). A failed wire aborts — never a silent gate-less lane (W68
		// degradation rule). Every dialect's wire.ts targets a GLOBAL config
		// file (not per-worktree), so this is safe to re-run on every dispatch.
		const WIRE_BY_AGENT: Record<string, string> = {
			codex: "codex",
			copilot: "copilot",
			grok: "grok",
			cline: "cline",
		};
		const wireDialect = WIRE_BY_AGENT[AGENT];
		if (wireDialect) {
			const wire = Bun.spawnSync(
				[
					process.execPath,
					`${import.meta.dir}/../dialects/${wireDialect}/wire.ts`,
				],
				{
					cwd: REPO,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (wire.exitCode !== 0) {
				console.error(
					`${wireDialect} gate wiring failed: ${new TextDecoder().decode(wire.stderr ?? new Uint8Array()).trim()}`,
				);
				throw new Error("direct launch preparation failed");
			}
		}
		// codex lanes: codex's seatbelt denies every write into any .git
		// directory (name-based, verified empirically 2026-09-28), so the standard
		// worktree layout (admin dir + objects under REPO/.git) can never commit.
		// The lane gets a PRIVATE git store under a non-.git name inside its
		// workspace, wired with GIT_DIR/GIT_WORK_TREE env: main-repo objects are
		// shared read-only via alternates; the lane's own objects/refs land in
		// the private store — the main object db stays seatbelt-protected.
		if (AGENT === "codex") {
			const store = `${wt}/.gitstore`;
			if (!existsSync(`${store}/HEAD`)) {
				Bun.spawnSync(["git", "init", "--quiet", "--bare", store]);
				const g = (args: string[]): void => {
					Bun.spawnSync(["git", "--git-dir", store, ...args], {
						cwd: REPO,
						stdout: "ignore",
						stderr: "ignore",
					});
				};
				g(["config", "core.bare", "false"]);
				g(["config", "core.worktree", wt]);
				writeFileSync(
					`${store}/objects/info/alternates`,
					`${REPO}/.git/objects\n`,
				);
				g([
					"update-ref",
					`refs/heads/suspenders/${item}`,
					sh(["git", "-C", REPO, "rev-parse", MAIN]),
				]);
				g(["symbolic-ref", "HEAD", `refs/heads/suspenders/${item}`]);
				g(["reset", "--hard", "--quiet"]);
				g([
					"remote",
					"add",
					"origin",
					sh(["git", "-C", REPO, "remote", "get-url", "origin"]),
				]);
				// loud, never silent: verify the store landed on the lane's branch
				// before spawning anyone (unborn main = lane can push origin main)
				const head = Bun.spawnSync(
					["git", "--git-dir", store, "symbolic-ref", "--short", "HEAD"],
					{ stdout: "pipe" },
				)
					.stdout?.toString()
					.trim();
				if (head !== `suspenders/${item}`) {
					console.error(
						`codex store init failed: HEAD=${head || "unborn"} — inspect ${store}`,
					);
					throw new Error("direct launch preparation failed");
				}
			}
			writeFileSync(`${wt}/.git`, `gitdir: ${store}\n`);
		}
		const agentArgs =
			AGENT === "codex"
				? // full access — owner directive 2026-09-28: codex lanes are
					// EQUIVALENT to claude lanes (same trust class, unsandboxed).
					// The seatbelt structurally denies git writes, which forked the
					// protocol into lane-commits vs coordinator-commits; one
					// approach, two backends. The private git store stays: even
					// unsandboxed, a codex lane's commits never touch the main
					// object db until the coordinator merges.
					["exec", "--sandbox", "danger-full-access", prompt]
				: AGENT === "copilot"
					? // W223.1 — copilot's own non-interactive flags (verified via
						// `copilot --help`): -p/--prompt exits after one turn;
						// --allow-all-tools is REQUIRED for non-interactive mode
						// (copilot otherwise blocks on a confirmation prompt it can
						// never receive headless); --allow-all-paths matches the
						// other dialects' unsandboxed worktree access.
						["-p", prompt, "--allow-all-tools", "--allow-all-paths"].concat(
							// W183.1 — only forward when the owner actually chose
							// a level; belt/llm: dispatch never reaches this branch
							// (separate litellm-gateway stack, out of scope here).
							EFFORT ? ["--reasoning-effort", EFFORT] : [],
						)
					: [
							"-p",
							prompt,
							"--allowedTools",
							"Bash(git:*) Bash(bun:*) Bash(qlty:*) Bash(rg:*) Bash(eza:*) Bash(ls:*) Bash(mkdir:*) Bash(sd:*) Bash(sed:*) Bash(diff) Edit Write",
							"--permission-mode",
							"acceptEdits",
						];
		// Detached harness children survive dispatcher process-group teardown.
		// unref only releases Bun's event-loop reference. exec keeps
		// the registry PID, stdin EOF avoids input waits, and logs feed the board.
		const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
		const laneLog = `${REPO}/.fleet/lane-${sid}.log`;
		// W177 jobslab: the same per-class ceilings the fleet scripts' spawn
		// recipe applies — claude/codex get the working caps, config-overridable
		// via <repo>/.fleet/jobslab.json.
		const slab = laneClassOf(AGENT);
		const js = jobslabFor(slab, `${REPO}/.fleet`);
		const fenced = fencedExecutor(`${REPO}/.fleet`, intent);
		proc = Bun.spawn(
			[
				"/bin/sh",
				"-c",
				`${jobslabPrefix(js)}${sq(fenced)} ${agentArgs.map(sq).join(" ")} < /dev/null >> ${sq(laneLog)} 2>&1`,
			],
			{
				detached: true,
				cwd: wt,
				env,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			},
		);
		await awaitLaunchRegistration(store, `${REPO}/.fleet`, intent, proc);
		const earlyExit = await Promise.race([
			proc.exited,
			Bun.sleep(1000).then(() => null),
		]);
		if (earlyExit !== null)
			throw new Error(`executor exited during launch (code ${earlyExit})`);
		proc.unref();
		const entry = {
			sid,
			item,
			pid: proc.pid,
			branch,
			worktree: wt,
			agent: AGENT,
			host: hostname(),
			slab,
			launchedAt: Date.now(),
			attempt: intent.attempt,
		};
		const all = lanes().filter((l) => l.sid !== sid);
		all.push(entry);
		assertLaunchClaim(store, intent, true);
		mergeLaneRegistry(REPO, all);
		accepted = true;
		log(
			`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch}, slab ${jobslabTag(slab, js)})`,
		);
		console.log(`dispatched ${item} → ${sid} (pid ${proc.pid})`);
	} catch (error) {
		console.error(`REFUSED ${item} — ${String(error)}`);
		process.exitCode = 1;
	} finally {
		if (!accepted) {
			let stopped = true;
			try {
				if (proc) await terminateOwnLaunch(proc);
			} catch {
				stopped = false;
				console.error("own child exit uncertain; claim preserved");
			}
			if (stopped) {
				if (intent) finishFailedLaunch(store, intent);
				if (revision !== undefined)
					releaseFailedLaunch(store, { project, item, sid, revision, nonce });
			}
		}
		releaseLaunchLease(store, project, sid, nonce);
		store.close();
	}
	process.exit(process.exitCode ?? 0);
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
	// never enter with leftover merge state (same as cycle step 1)
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		healCrashedMerge();
	}
	mergeOne(b);
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

if (MODE === "once") {
	await cycle();
	process.exit(0);
}

// watch: each cycle is a killable --once child under a watchdog timer
log(
	`fleet-loop start pid=${process.pid} repo=${REPO} glob=${GLOB} every=${EVERY_MS / 1000}s watchdog=${CYCLE_TIMEOUT_MS / 60000}min`,
);
while (true) {
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
