#!/usr/bin/env bun
// Refill READY work and resume dead claimed lanes under the fleet-loop scheduler.
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { BIN, composeBrief } from "./lib/brief.ts";

export { composeBrief };

// W157 decomposition: the pure governance decisions live in their module;
// re-exported so existing importers (tests, scripts) keep their path.
import {
	laneKeyDecision,
	parseGovernanceMode,
	probeFrontDecision,
} from "./lib/governance-decide.ts";
import {
	coordCliFor,
	laneAuditFor,
	probeBuckleFront,
	residueOf,
	run as runShared,
	sh as shShared,
	workCliFor,
} from "./lib/lane.ts";
import { adminKey } from "./lib/lane-auth.ts";
import { grinderGate } from "./lib/lane-death-capture.ts";
// W519: .prefer prefer= soft routing — the brief carries the constraint
import {
	preferRoutingBriefLines,
	resolveRoutingPrefer,
} from "./lib/prefer-routing.ts";

export type { GovernanceDecision } from "./lib/governance-decide.ts";
// W615: hubAttributionDecision rides the re-export so existing importers
// (tests, scripts) keep the dispatch-next path.
export { hubAttributionDecision } from "./lib/governance-decide.ts";
export { laneKeyDecision, parseGovernanceMode, probeFrontDecision };

import { forecastPush } from "../hooks/lib/credit-forecast.ts";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
// W494.1: the worktree-cwd probe is the shared EVIDENCE helper now — the
// verdict itself lives in hooks/lib/lane-liveness.ts (pid/heartbeat, never cwd)
import {
	laneProcessIdentity,
	worktreeLive,
} from "../hooks/lib/lane-liveness.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
	mergeLaneRegistry,
} from "../hooks/lib/lane-registry.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
// W911: the bounded plaid posture — the ONE override of the execPick chain.
import { plaidProbeHealth, readPosture } from "../hooks/lib/plaid.ts";
// W862: policy provenance rides the brief — read-only graph read, the
// compliance check itself re-runs at the lane's session bootstrap
import { policyBriefLines } from "../hooks/lib/session-policy.ts";
import { recoverOrphanClaims } from "./lib/claim-recovery.ts";
import { flushLaneUsageFacts, meterCopilotLanes } from "./lib/copilot-meter.ts";
import { isDeferredItem } from "./lib/dispatch-defers.ts";
import { fleetReport } from "./lib/fleet-report.ts";
import { activeRateLimitWalls } from "./lib/launch-backoff.ts";
import {
	heldLaunchItems,
	readConfiguredLaunches,
} from "./lib/launch-fencing.ts";
// W636 decomposition: the READY-pool helpers + the archived-origin landing
// guard moved to lib modules; the re-exports keep supervise.ts and the test
// suites on their dispatch-next import path.
import { capabilityGate, isOwnerGated, parseReady } from "./lib/ready-pool.ts";
import {
	canAttemptRefill,
	dispatchHeld,
	plaidCycleOpen,
	plaidLaunchGapMs,
	refillWindow,
} from "./lib/refill-window.ts";
import { isResumableClaim } from "./lib/resumable-claim.ts";

export { capabilityGate, isOwnerGated, parseReady };

import {
	type DispatchLane as Lane,
	parseCapsuleGet,
	RouteAdmission,
} from "./lib/dispatch-admission.ts";
// W1238.6.4: the launch pipeline lives here — deps bag carries the
// entrypoint-bound closures (W928 pattern).
import { type DispatchItemDeps, dispatchItem } from "./lib/dispatch-item.ts";
import {
	dispatchSummary,
	resolveDaemonizedPids,
} from "./lib/dispatch-summary.ts";

// parseCapsuleGet is re-exported so supervise.ts and the test suites keep
// their dispatch-next import path (W576.1.1 decomposition).
export { parseCapsuleGet };

const argv = process.argv.slice(2);
// Command discovery must precede repo lookup, claims, registry writes and spawn.
// `registry <verb> --help` belongs to the registry verb below, not this usage.
if (
	import.meta.main &&
	argv[0] !== "registry" &&
	(argv.includes("--help") || argv.includes("-h"))
) {
	console.log(`Usage: dispatch [options]

Refill agent lanes from READY work and resume unfinished claims.

  --repo <dir>             Project checkout (default: Git root)
  --target <N>             Steady posture live lane target (default: 6);
                           plaid grows one attempted launch per cycle
  --dry-run                Preview without launching or changing claims
  --item <Wn>              Dispatch one specific work item
  --route <name>           Pin a plaid route for --item; no model fallback
  --no-belt                Skip belt executor selection
  --allow-ungoverned       Explicitly allow a surfaced governance bypass
  --show-capsule <sid>      Print a lane's saved continuation capsule
  --resume-from <sid>       With --item: resume the prior lane's transcript
                            (claude --resume --fork-session). Policy-gated:
                            SUSPENDERS_RESUME_RETAKE=on + cache-warm
                            transcript fence; any miss = fresh + capsule.
  registry list|prune|forget  Inspect the durable lane registry; prune removes
                            entries whose lane is provably dead (liveness-
                            guarded; live/unknown entries are retained)
  intent inspect|fail      Inspect launch intents (+liveness verdicts) or mark a
                            wedged intent FAILED — liveness-guarded, --evidence
                            required, never a live lane
  -h, --help               Print this help without dispatching

Crash recovery defaults to three total launches per lane.
Set SUSPENDERS_CLAUDE_BIN or SUSPENDERS_COPILOT_BIN to an absolute executable path.
Set SUSPENDERS_LANE_MAX_ATTEMPTS to a value from 1 to 100 to override.`);
	process.exit(0);
}
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
// Steady posture's target. Plaid ignores this numeric ceiling.
const TARGET = Number(val("--target") ?? 6);
// Spawn helpers keep call sites cwd-free.
const sh = (cmd: string[], cwd = REPO): string => shShared(cmd, cwd);
const run = (cmd: string[], cwd = REPO): { code: number; out: string } =>
	runShared(cmd, cwd);

export { residueOf };

// W629 DRY: the execPath+CLI prefix builders hoisted to lib/lane.ts (W911
// 1500-law decomposition); call sites pass the verb tail (rest params fold
// the conditional spreads several sites carry).
const workCli = workCliFor(BIN);
const coordCli = coordCliFor(BIN);
// W494: REPO is the repo ROOT, never cwd — the loop runs from
// packages/<name> in the monorepo, and worktrees/briefs live at
// <root>/.worktrees (worktree.ts derives toplevel from the project
// identity). cwd-as-root ENOENT'd the brief write mid-dispatch and
// stranded half-born claims. (sh/run hoist above this so the toplevel
// probe delegates to the shared spawn helper instead of re-inlining it —
// REPO's default param is call-time-safe.)
const gitToplevel = (): string =>
	sh(["git", "rev-parse", "--show-toplevel"], process.cwd()) || process.cwd();
const CALLER_REPO = resolve(val("--repo") ?? gitToplevel());
const ROUTING_PREFER = resolveRoutingPrefer(CALLER_REPO);
const REPO = canonicalProjectRoot(CALLER_REPO);
const DRY = argv.includes("--dry-run");
// explicit single-item dispatch (W145 docstring promised this, never wired
// up): bypasses the FIFO ready-pool pick so a caller with its own priority
// analysis (collision-checked picks, owner direction) can target one item
// precisely instead of whatever sorts first in `work ready`.
const ITEM = val("--item");
const ROUTE = val("--route");
const NO_BELT = argv.includes("--no-belt");
// W463 fail-closed governance: belt-direct is never a silent fallback. When
// the buckle front answers but the lane key can't be minted, dispatch REFUSES
// unless the operator passed this flag (loud, logged, disclosed in the brief).
const ALLOW_UNGOVERNED = argv.includes("--allow-ungoverned");
const SHOW_CAPSULE = val("--show-capsule");
// W622 retake knob (scripts/lib/resume-from.ts): explicit transcript
// resume for a retake — requires --item <id>; policy-gated by
// SUSPENDERS_RESUME_RETAKE=on + the freshness fence. Default OFF —
// doctrine stays fresh lane + capsule.
const RESUME_FROM = val("--resume-from");
const FLEET = `${REPO}/.fleet`;
// --target never caps Plaid; refill-window.ts controls launch cadence.
const POSTURE = readPosture(FLEET);
if (argv.includes("--route") && (!ROUTE || !ITEM || POSTURE !== "plaid"))
	throw new Error("--route requires --item in plaid posture");
// W989: one catalog probe per run — plaid lanes only ride models the buckle
// front actually serves (a pin the front can't serve launches a lane that
// 502s on its first request, W1019). The /v1/models read is auth-gated by
// the one lane-auth admin-key reader (W1063, env-first over belt.env).
// W1102.1: the probe result (null = catalog unavailable) rides the plaid
// launch preflight — an unavailable catalog holds EVERY plaid launch
// (fail-closed); reachable-empty `[]` stays valid evidence.
const PLAID_MODEL_HEALTH =
	POSTURE === "plaid" && !NO_BELT && !DRY
		? await plaidProbeHealth(await probeBuckleFront(), adminKey())
		: undefined;
// W636: `registry` verb family — liveness-guarded operator cleanup of the
// durable lane registry (list/prune/forget); command discovery precedes the
// dispatch pipeline exactly like --help above. Dynamic import: the verb
// module costs nothing on a normal dispatch run.
if (import.meta.main && argv[0] === "registry") {
	const { registryMain } = await import("./lib/registry-cli.ts");
	process.exit(await registryMain(argv.slice(1), { fleet: FLEET }));
}
if (import.meta.main && argv[0] === "intent") {
	const { intentMain } = await import("./lib/launch-intent-cli.ts");
	process.exit(intentMain(argv.slice(1), { repo: REPO }));
}
const LOOP_LOG = `${FLEET}/loop.log`;
// W463: mint failures refuse the dispatch (fail-closed). Collected so main()
// exits non-zero — a refused lane must not read as a healthy no-op dispatch.
const governanceRefusals: string[] = [];
const launchWaits: string[] = [];
// W695.1: seed-failure fallbacks — dispatched cold because the starter seed
// failed. Surfaced in the final summary line and carried on the registry row.
const seedFallbacks: string[] = [];
const routeAdmission = new RouteAdmission(
	!DRY && !NO_BELT,
	probeBuckleFront,
	adminKey,
	// W1102.1: plaid posture fails closed on an UNAVAILABLE audit read
	// (front down/401/timeout); steady keeps missing-evidence-never-blocks
	POSTURE === "plaid",
);

// .prefer routing errors are loud; valid soft and reserved rules ride the brief.
const routingExtra = (): string[] => {
	for (const e of ROUTING_PREFER.errors) console.log(`NOTE — .prefer ${e}`);
	return preferRoutingBriefLines(ROUTING_PREFER);
};
// W622 retake knob helpers live in scripts/lib/resume-from.ts (1500-line
// law): decisionFor resolves the operator's --resume-from against the
// lane-registry resume candidate; resumeBriefLine renders the disclosure.

// lane liveness is THE plane's verdict (2026-10-05) — hoisted to lib/lane.ts
// (W911 1500-law decomposition); the wrapper binds the CLI builders + dir.
const laneAudit = (): Map<string, boolean> => laneAuditFor(workCli, FLEET);
const laneAlive = (l: Lane, audit: Map<string, boolean>): boolean =>
	audit.get(l.sid) === true || laneProcessIdentity(l) !== false;
const log = (msg: string): void => {
	mkdirSync(FLEET, { recursive: true });
	appendFileSync(LOOP_LOG, `${new Date().toISOString()} ${msg}\n`);
};
const loadLanes = (): Lane[] => loadLaneRegistry<Lane>(FLEET);
const saveLanes = (lanes: Lane[]): void => mergeLaneRegistry(FLEET, lanes);

// W636 decomposition: READY-pool helpers (parseReady, isOwnerGated,
// capabilityGate) moved to scripts/lib/ready-pool.ts; re-exports at the
// import block keep supervise.ts + the test importers on their path.

/** decision-gated items never ride the automagic — they surface to the owner. */
// governance mode: read ONCE per dispatch run, through the coord CLI the
// script already uses for facts (copilot-meter pattern) — no second store,
// no raw sqlite on governor.db. Absent/broken fact reads fold to strict.
let governanceModeCache: "strict" | "solo" | null = null;
const governanceMode = (): "strict" | "solo" => {
	if (governanceModeCache) return governanceModeCache;
	governanceModeCache = parseGovernanceMode(
		run(coordCli("fact", "get", "fleet.governance")).out,
	);
	return governanceModeCache;
};

const capsuleGet = (sid: string): Record<string, string> | null =>
	parseCapsuleGet(sh(coordCli("capsule", "get", "--as", sid)));

/** W617: the item-scoped capsule (work.<id>.capsule) — travels with the
 *  item across reclaim/re-take, so any fresh claimer resumes informed. */
export const itemCapsuleGet = (item: string): Record<string, string> | null =>
	parseCapsuleGet(sh(coordCli("capsule", "get", "--item", item)));

/** the mission brief. Everything a headless lane needs: full item spec,
 *  capsule protocol, landing chain, sid + how it gets resumed. Resume runs
 *  embed the dead lane's last capsule as RESUME CONTEXT. */
// W862: policy provenance lines — read-only graph read over an ephemeral
// store handle; both brief sites (dry + live) disclose the same way.
const policyBriefExtra = (project: string): string[] => {
	const db = openStore();
	try {
		return policyBriefLines(db, project);
	} finally {
		db.close();
	}
};
// W460: sidOf is the legacy-named alias of the canonical laneSid —
// dispatch/supervise/fleet-loop/board must never derive sids independently
export const sidOf = laneSid;

// W928 decomposition modules can't close over the entrypoint's
// REPO/CLI-bound closures — they arrive via deps bags.
const previewDeps = {
	REPO,
	CALLER_REPO,
	RESUME_FROM,
	sh,
	run,
	workCli,
	capsuleGet,
	itemCapsuleGet,
	routingExtra,
	policyBriefExtra,
};

// W1238.6.4: the launch pipeline lives in lib/dispatch-item.ts — this bag
// carries the entrypoint-bound closures + flags it needs (deps-first arg).
const dispatchItemDeps: DispatchItemDeps = {
	REPO,
	FLEET,
	CALLER_REPO,
	RESUME_FROM,
	DRY,
	NO_BELT,
	ALLOW_UNGOVERNED,
	ROUTE,
	POSTURE,
	PLAID_MODEL_HEALTH,
	ROUTING_PREFER,
	routeAdmission,
	governanceRefusals,
	launchWaits,
	seedFallbacks,
	sh,
	run,
	workCli,
	coordCli,
	log,
	loadLanes,
	saveLanes,
	capsuleGet,
	governanceMode,
	previewDeps,
};

const dispatch = (
	item: string,
	lanes: Lane[],
	resume?: Lane,
	ordinal = 0,
): Promise<string | null> =>
	dispatchItem(dispatchItemDeps, item, lanes, resume, ordinal);

const main = async (): Promise<void> => {
	if (SHOW_CAPSULE) {
		console.log(sh(coordCli("capsule", "get", "--as", SHOW_CAPSULE)));
		return;
	}
	if (RESUME_FROM && !ITEM) {
		console.log("REFUSED --resume-from <sid> requires --item <id>");
		process.exitCode = 2;
		return;
	}
	if (!DRY && dispatchHeld(FLEET)) {
		console.log("WAIT — dispatch paused for rollout; live lanes keep running");
		return;
	}
	// prune: dead entries leave lanes.json (history keeps the audit); a worktree
	// with a live claude/codex cwd is alive no matter what the pid says —
	// daemonized `claude -p` re-parents away from the recorded pid within minutes.
	const lanes = loadLanes();
	const audit = laneAudit();
	const held = DRY
		? new Set<string>()
		: readConfiguredLaunches((store) =>
				heldLaunchItems(store, projectIdentity(REPO)),
			);
	// Old automatic claims can outlive their registry rows. Reconstruct the
	// original sid instead of reclaiming it and losing capsule/retry identity.
	// W928: the capture + candidate math ride scripts/lib/claim-recovery.ts.
	const recovered = await recoverOrphanClaims({
		workCli,
		repo: REPO,
		log,
		dry: DRY,
		...(ITEM ? { item: ITEM } : {}),
		takenSids: new Set(lanes.map((l) => l.sid)),
		targetEff: TARGET,
		...(POSTURE === "plaid" ? { maxRows: 1 } : {}),
		busySlots: Math.max(held.size, [...audit.values()].filter(Boolean).length),
		now: Date.now(),
	});
	if (recovered.refused) {
		process.exitCode = 1;
		return;
	}
	for (const row of recovered.rows) {
		lanes.push({
			sid: row.owner_sid,
			item: row.id,
			pid: 0,
			branch: `suspenders/${row.id}`,
			worktree: `${REPO}/.worktrees/${row.id}`,
			host: hostname(),
			launchedAt: row.updated_at,
			attempt: 0,
		});
		const note = `recovered missing registry identity ${row.id} → ${row.owner_sid}`;
		console.log(`${DRY ? "DRY " : ""}${note}`);
		if (!DRY) log(note);
	}
	// W494.1: the audit (session rows) alone lies — daemonized `claude -p`
	// lanes die silently and their session lease outlives them. A lane is
	// live only if the audit votes yes AND a claude/codex process actually
	// sits in its worktree, with a 10-minute launch grace so a fresh spawn
	// isn't re-dispatched before its cwd shows up in lsof.
	const live = lanes.filter(
		(l) =>
			laneAlive(l, audit) &&
			(worktreeLive(l.worktree) ||
				Date.now() - (l.launchedAt ?? 0) < 10 * 60_000),
	);
	const heldSlots = [...held].filter(
		(item) => !live.some((l) => l.item === item),
	).length;
	// W761: the grinder breaker — most-recent lane deaths sub-minute means
	// the environment kills lanes faster than work progresses; relaunching
	// just burns budgets. Fail-open: a dark store never blocks dispatch.
	if (!DRY && !ITEM) {
		try {
			const bstore = openStore();
			const g = grinderGate(bstore, (note) =>
				run(
					coordCli(
						"emit",
						"NEED_DECISION",
						"--as",
						"dispatch",
						"--scope",
						"suspenders",
						"--note",
						note,
					),
				),
			);
			bstore.close();
			if (g.tripped) {
				console.log(
					`GRINDER ${g.subMinute}/${g.samples} recent lane deaths sub-minute — launches refused (W761 breaker)`,
				);
				return;
			}
		} catch {
			// fail-open
		}
	}
	// Plaid observes pressure between launches; steady keeps its numeric target.
	let walls = 0;
	if (!DRY && !ITEM) {
		try {
			const pstore = openStore();
			walls = activeRateLimitWalls(pstore, projectIdentity(REPO));
			pstore.close();
		} catch {
			// dark-store fallback remains visible through the route admission gate
		}
	}
	let window = refillWindow(POSTURE, TARGET, live.length, walls);
	if (walls > 0)
		console.log(
			POSTURE === "plaid"
				? `PACED — ${walls} active rate-limit wall(s); new Plaid launches paused until recovery`
				: `PACED — ${walls} active rate-limit wall(s); effective target ${window.target}/${TARGET} (W1025)`,
		);
	// resume candidates: dead dispatched lanes whose item is still CLAIMED by
	// them (state on the graph) — re-dispatch with the same sid so the capsule
	// fact (lane.<sid>.capsule) and the claim both carry over.
	const resumeOf = new Map<string, Lane>();
	for (const l of lanes.filter(
		(x) => !live.includes(x) && (!ITEM || x.item === ITEM),
	)) {
		if (worktreeLive(l.worktree)) continue; // raced between filter and here
		const show = run(workCli("show", l.item, "--json"));
		if (show.code !== 0 || !isResumableClaim(show.out, l.item, l.sid)) continue;
		resumeOf.set(l.item, l);
	}
	const dispatched: string[] = [];
	let plaidRefused = false;
	const plaidCycleStarted = Date.now();
	const canLaunch = (): boolean =>
		!plaidRefused &&
		(POSTURE !== "plaid" || plaidCycleOpen(plaidCycleStarted, Date.now())) &&
		(DRY || !dispatchHeld(FLEET)) &&
		canAttemptRefill(window, live.length + heldSlots + dispatched.length);
	const afterLaunch = async (): Promise<void> => {
		if (POSTURE !== "plaid" || DRY || ITEM) return;
		await Bun.sleep(
			plaidLaunchGapMs(process.env.SUSPENDERS_PLAID_LAUNCH_GAP_MS),
		);
		routeAdmission.invalidate();
		try {
			const pstore = openStore();
			walls = activeRateLimitWalls(pstore, projectIdentity(REPO));
			pstore.close();
			window = refillWindow(POSTURE, TARGET, live.length, walls);
		} catch {
			// Exact-target route audit and provider quota still gate the next item.
		}
	};
	for (const [, resume] of resumeOf) {
		if (!canLaunch()) break;
		const out = await dispatch(resume.item, live, resume);
		if (out) dispatched.push(out);
		// W1145: item-local deferrals don't stop the refill; global holds do.
		else if (POSTURE === "plaid" && !isDeferredItem(resume.item)) {
			plaidRefused = true;
			break;
		}
		await afterLaunch();
	}
	if (ITEM && !live.some((l) => l.item === ITEM) && !resumeOf.has(ITEM)) {
		if (!canLaunch() && !held.has(ITEM)) {
			console.log(
				`REFUSED ${ITEM} — ${POSTURE === "plaid" ? "rate-limit wall or dispatch hold" : "target capacity occupied by live or uncertain launches"}`,
			);
			governanceRefusals.push(ITEM);
		} else {
			// W622: an explicit --resume-from pins the retake to a dead lane's
			// transcript; no registry row = cold dispatch, disclosed.
			const explicitResume = RESUME_FROM
				? loadLanes().find((l) => l.sid === RESUME_FROM && l.item === ITEM)
				: undefined;
			if (RESUME_FROM && !explicitResume)
				console.log(
					`NOTE — --resume-from ${RESUME_FROM}: no dead lane registered for ${ITEM}; cold dispatch`,
				);
			const out = await dispatch(ITEM, live, explicitResume);
			if (out) dispatched.push(out);
		}
	}
	// fresh READY pool (id order = FIFO priority; `work ready` already gates on
	// requires/blocks deps AND on DONE-but-unmerged dep shas via depsMet).
	// Skipped entirely for an explicit --item — that caller already did its
	// own priority analysis and must not be drowned out by the FIFO pool.
	const ready = ITEM
		? []
		: parseReady(run(workCli("ready")).out).filter(
				(r) =>
					!live.some((l) => l.item === r.id) &&
					!held.has(r.id) &&
					!resumeOf.has(r.id) &&
					!isOwnerGated(r.title),
			);
	// W619 capability pre-filter: `work take` refuses requires ⊆ session caps
	// at claim time, and a never-dispatched sid has NO sessions row yet — so
	// attempting the take burns a cycle and dies "dispatch to a capable agent".
	// Skip pre-take with the missing caps named; aggregate the demanded-but-
	// unoffered capabilities as the starved set (swarm-comms-research item 5).
	const capStore = ready.length ? openStore() : null;
	const sidCaps = (sid: string): string[] =>
		(
			(capStore
				?.query("SELECT capabilities FROM sessions WHERE sid = ?")
				.get(sid) as { capabilities: string | null } | null) ?? {
				capabilities: null,
			}
		).capabilities
			?.split(",")
			.map((c) => c.trim())
			.filter(Boolean) ?? [];
	const { dispatchable, starved, skips } = capabilityGate(
		ready,
		sidCaps,
		(id) => sidOf(id, projectIdentity(REPO)),
	);
	for (const s of skips) console.log(s);
	capStore?.close();
	for (const r of dispatchable) {
		if (!canLaunch()) break;
		const out = await dispatch(r.id, live, undefined, dispatched.length);
		if (out) dispatched.push(out);
		else if (POSTURE === "plaid" && !isDeferredItem(r.id)) {
			plaidRefused = true;
			break;
		}
		await afterLaunch();
	}
	// daemonized-pid resolve: scripts/lib/dispatch-summary.ts (W928)
	await resolveDaemonizedPids(sh, dispatched, live);
	// dry-run is read-only end to end — never rewrite the lane registry.
	// BUGFIX: dispatchItem pushes fresh entries into `live` (a .filter() copy
	// of `lanes`, not the same array) — persisting the stale outer `lanes`
	// silently dropped every successful dispatch from the registry. Dead
	// entries (not in `live`, same object refs since filter preserves them)
	// stay for history; `live` carries both survivors and new dispatches.
	if (!DRY) saveLanes([...lanes.filter((l) => !live.includes(l)), ...live]);
	// W223.2 credit metering: flush copilot lane spend into `lane.<sid>.usage`
	// facts once per dispatch cycle (fleet-loop drives this every --every
	// cycle — totals stay fresh with no new daemon). Fail-soft, same doctrine
	// as aid-harvest: metering must never kill a dispatch.
	if (!DRY) {
		try {
			const meter = meterCopilotLanes(FLEET);
			if (meter.ok) {
				const stamped = flushLaneUsageFacts(meter);
				if (stamped.length > 0)
					console.log(`copilot meter: stamped ${stamped.join(", ")}`);
			}
		} catch (e) {
			console.log(
				`NOTE — copilot meter flush failed (soft): ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	// W566 premium-credit headroom: forecast the push against the sampled
	// plan counter (fail-soft, meter-flush doctrine — forecasting never
	// kills a dispatch). Alerts dedupe via the shared state file, so this
	// is quiet unless an arm fires or the dedupe window lapses.
	if (!DRY) {
		try {
			const line = forecastPush({ act: true, queued: ready.length });
			if (line !== null) console.log(`credit forecast: ${line}`);
		} catch (e) {
			console.log(
				`NOTE — credit forecast failed (soft): ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	// W899/W928: the tail render + exit-code decision ride dispatch-summary.ts
	process.exitCode = dispatchSummary({
		liveCount: live.length,
		targetEff: window.target,
		heldSlots,
		dispatched,
		seedFallbacks,
		readyCount: ready.length,
		resumeCount: resumeOf.size,
		...(ITEM ? { item: ITEM } : {}),
		refusals: governanceRefusals,
		launchWaits,
		starved,
		report: fleetReport(REPO),
	});
};

if (import.meta.main) {
	if (SHOW_CAPSULE || !DRY) mkdirSync(FLEET, { recursive: true });
	await main();
}
