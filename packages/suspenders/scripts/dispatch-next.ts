#!/usr/bin/env bun
// Refill READY work and resume dead claimed lanes under the fleet-loop scheduler.
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { capsuleValidity } from "../hooks/lib/capsule-fence.ts";
import { verifiedContextContinuation } from "../hooks/lib/reclaim-context.ts";
import { BIN, composeBrief } from "./lib/brief.ts";
import { briefVerdictLine, verifyBrief } from "./lib/brief-verify.ts";

export { composeBrief };

// W422: executor specifics ride the adapter registry (hooks/lib/executors/)
// — dispatch composes adapter.spawnArgs/verifyBrief-harness, no per-agent
// branches. The spawn-args INTERFACE lives in scripts/lib/lane.ts.
import { adapterFor } from "../hooks/lib/executors/registry.ts";
import { dispatchLaneEffort } from "../hooks/lib/lane-effort-policy.ts";
// W157 decomposition: the pure governance decisions live in their module;
// re-exported so existing importers (tests, scripts) keep their path.
import {
	laneKeyDecision,
	parseGovernanceMode,
	probeFrontDecision,
} from "./lib/governance-decide.ts";
import { discloseInBrief, noBeltNote } from "./lib/governance-disclose.ts";
import { attributeHubLane } from "./lib/hub-lane.ts";
import { applyInsertion, insertionCtx } from "./lib/insertion.ts";
import { jobslabFor, jobslabTag, laneClassOf } from "./lib/jobslab.ts";
import {
	applyLaneAttribution,
	coordCliFor,
	executorLaunch,
	laneAuditFor,
	laneEnv,
	probeBuckleFront,
	recreateWorktreeFor,
	residueOf,
	run as runShared,
	sh as shShared,
	spawnClaude,
	workCliFor,
} from "./lib/lane.ts";
import {
	adminKey,
	ensureLaneKey,
	LANE_KEY_TTL_S,
	laneKeyMetaPath,
} from "./lib/lane-auth.ts";
import { grinderGate } from "./lib/lane-death-capture.ts";
// W512: lane --settings composer — env grammar + the Task-pin hook block
import { laneSettingsData } from "./lib/lane-settings.ts";
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
import { quotaProviderPenalty } from "../hooks/lib/exec-quota.ts";
import {
	cvMap,
	executorCv,
	recordLaneExecutor,
	writeExecutorCvFacts,
} from "../hooks/lib/executor-cv.ts";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
import { resolveHub } from "../hooks/lib/hub-locate.ts";
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
import {
	plaidProbeHealth,
	readPosture,
	recordPlaidTrace,
} from "../hooks/lib/plaid.ts";
// W862: policy provenance rides the brief — read-only graph read, the
// compliance check itself re-runs at the lane's session bootstrap
import { policyBriefLines } from "../hooks/lib/session-policy.ts";
import {
	darkHubNow,
	policyForRepo,
	tryLoadStack,
} from "../hooks/lib/stack-config.ts";
// W1102.1: the plaid launch preflight (host-pressure hold + pool plan +
// route pick) — its own module per the 1500-line law
import { plaidLaunchPreflight } from "../scripts/lib/plaid-launch.ts";
import { recoverOrphanClaims } from "./lib/claim-recovery.ts";
import { flushLaneUsageFacts, meterCopilotLanes } from "./lib/copilot-meter.ts";
import { deferItem, isDeferredItem } from "./lib/dispatch-defers.ts";
import { execPick, posturePreference } from "./lib/exec-chain.ts";
import { fleetReport } from "./lib/fleet-report.ts";
import { laneAttemptLimit, nextLaneAttempt } from "./lib/lane-retry-budget.ts";
import { dispatchStarterFork, starterStartLine } from "./lib/lane-starter.ts";
import {
	activeRateLimitWalls,
	parkExhaustedLaunch,
	readLaunchBackoff,
	scheduleLaunchBackoff,
} from "./lib/launch-backoff.ts";
import { launchCleanup } from "./lib/launch-cleanup.ts";
import {
	assertLaunchClaim,
	awaitLaunchRegistration,
	fencedExecutor,
	heldLaunchItems,
	inspectLaunchIntent,
	type LaunchIntent,
	launchIntent,
	nextReservedAttempt,
	readConfiguredLaunches,
	reserveLaunchIntent,
} from "./lib/launch-fencing.ts";
import { launchParent } from "./lib/launch-parent.ts";
import {
	acquireLaunchLease,
	renewLaunchLease,
	resolveLaneExecutor,
} from "./lib/launch-preflight.ts";
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
import { decisionFor, resumeBriefLine } from "./lib/resume-from.ts";
import { verdictRepeatGate } from "./lib/verdict-repeat-gate.ts";

export { capabilityGate, isOwnerGated, parseReady };

import {
	type DispatchLane as Lane,
	parseCapsuleGet,
	RouteAdmission,
} from "./lib/dispatch-admission.ts";
import {
	composeDispatchBrief,
	dryDispatchPreview,
} from "./lib/dispatch-preview.ts";
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

const recreateWorktree = (
	item: string,
	owner: string,
	revision: number,
): string | null => recreateWorktreeFor(item, BIN, owner, revision);
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

/** one item → claim, worktree, brief, daemonized lane. Returns the summary
 *  fragment or null when the item cannot be taken (claimed elsewhere). */

const dispatchItem = async (
	item: string,
	lanes: Lane[],
	resume?: Lane,
	/** position in this dispatch cycle — plaid's round-robin ordinal */
	ordinal = 0,
): Promise<string | null> => {
	const sid = resume?.sid ?? sidOf(item, projectIdentity(REPO));
	let attempt = resume ? nextLaneAttempt(resume.attempt ?? 0) : 0;
	const limit = laneAttemptLimit(process.env.SUSPENDERS_LANE_MAX_ATTEMPTS);
	const project = projectIdentity(REPO);
	const laneLog = `${FLEET}/lane-${sid}.log`;
	let hold = readConfiguredLaunches((store) =>
		readLaunchBackoff(store, project, item),
	);
	if (resume && !DRY && hold?.attempt !== resume.attempt) {
		const store = openStore();
		try {
			hold = scheduleLaunchBackoff(
				store,
				project,
				item,
				laneLog,
				resume.attempt,
			);
		} finally {
			store.close();
		}
	}
	if (hold && Date.now() < hold.eligibleAt) {
		launchWaits.push(item);
		console.log(
			`WAIT ${item} — ${hold.kind} launch backoff until ${new Date(hold.eligibleAt).toISOString()} (evidence ${hold.log})`,
		);
		return null;
	}
	if (!DRY) {
		const pending = readConfiguredLaunches((store) =>
			launchIntent(store, projectIdentity(REPO), item),
		);
		if (pending && inspectLaunchIntent(pending) !== "dead") {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — durable launch intent alive or uncertain; nothing claimed or minted`,
			);
			return null;
		}
	}
	// W896 verdict-repeat gate (scripts/lib/verdict-repeat-gate.ts): a capsule
	// that re-banks the verbatim verdict its prior attempt closed on flips
	// the item to the operator-gated class (FAILED + NEED_DECISION, verdict
	// on the card) instead of a re-spawn.
	if (
		resume &&
		!DRY &&
		verdictRepeatGate({
			item,
			sid,
			capsule: capsuleGet(sid),
			run,
			coordCli,
			workCli,
			log,
		})
	)
		return null;
	if (resume && attempt >= limit) {
		launchWaits.push(item);
		if (DRY)
			console.log(
				`DRY ${item} — resume budget exhausted; would return to READY with backoff`,
			);
		else {
			const store = openStore();
			try {
				const parked = parkExhaustedLaunch(
					store,
					project,
					item,
					sid,
					laneLog,
					attempt,
				);
				console.log(
					parked
						? `WAIT ${item} — ${parked.kind} launch exhausted; returned to READY until ${new Date(parked.eligibleAt).toISOString()} (evidence ${parked.log})`
						: `REFUSED ${item} — claim changed; preserved for its owner`,
				);
			} finally {
				store.close();
			}
		}
		return null;
	}
	const wt = `${REPO}/.worktrees/${item}`;
	if (DRY && ROUTE)
		console.log(
			`DRY route pin ${ROUTE} (live health/capacity checked at launch; no fallback)`,
		);
	if (DRY)
		return dryDispatchPreview(previewDeps, {
			item,
			sid,
			attempt,
			wt,
			resumeSid: resume?.sid,
			routePin: ROUTE,
		});
	const store = openStore();
	// W620 measure beat: fold the events into facts BEFORE the ladder reads
	// them — the measure-gate that lets execPick act on real skew only.
	writeExecutorCvFacts(store, executorCv(store));
	const cv = cvMap(store, hostname());
	// W374: the per-provider quota penalty the pick routes around — read once
	// per dispatch cycle, next to the cv ladder it outranks.
	const quota = quotaProviderPenalty(store);
	const attemptKey = `lane.${sid}.launch-attempt`;
	attempt = nextReservedAttempt(store, project, item, attempt, sid);
	if (attempt >= limit) {
		launchWaits.push(item);
		const parked = parkExhaustedLaunch(
			store,
			project,
			item,
			sid,
			laneLog,
			attempt,
		);
		console.log(
			parked
				? `WAIT ${item} — launch budget exhausted; READY after ${new Date(parked.eligibleAt).toISOString()} (evidence ${parked.log})`
				: `REFUSED ${item} — launch budget exhausted; claim changed`,
		);
		store.close();
		return null;
	}
	let pick = execPick(attempt, CALLER_REPO, cv, quota);
	let bin = resolveLaneExecutor(pick.bin);
	/** W911: the plaid route this lane rides — null in steady posture. */
	let routeName: string | null = null;
	if (!bin) {
		governanceRefusals.push(item);
		console.log(
			`REFUSED ${item} — executor unavailable: ${pick.bin}; set SUSPENDERS_${pick.bin.toUpperCase()}_BIN or install in ~/.local/bin; nothing claimed or minted`,
		);
		store.close();
		return null;
	}
	const nonce = crypto.randomUUID();
	if (!acquireLaunchLease(store, project, sid, nonce)) {
		console.log(
			`REFUSED ${item} — another dispatcher owns the launch lease; nothing claimed or minted`,
		);
		governanceRefusals.push(item);
		store.close();
		return null;
	}
	let claimRevision: number | undefined;
	let committedLaunch = false;
	let launchedProc: ReturnType<typeof spawnClaude> | undefined;
	let ownedKeyId: string | undefined;
	/** W615: set when the lane key was minted AT a hub — launch-cleanup
	 *  revokes there with the hub credential, not against the local front. */
	let ownedKeyFront: string | undefined;
	let intent: LaunchIntent | undefined;
	const writtenFiles = new Map<string, string>();
	try {
		const published = loadLanes().find((l) => l.sid === sid);
		if (published && laneProcessIdentity(published) !== false) {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — durable registry already holds a live or unknown lane; nothing claimed or minted`,
			);
			return null;
		}
		const pending = launchIntent(store, project, item);
		if (pending && inspectLaunchIntent(pending) !== "dead")
			throw new Error("durable launch intent alive or uncertain");
		attempt = nextReservedAttempt(store, project, item, attempt, sid);
		if (attempt >= limit) {
			launchWaits.push(item);
			const parked = parkExhaustedLaunch(
				store,
				project,
				item,
				sid,
				laneLog,
				attempt,
			);
			console.log(
				parked
					? `WAIT ${item} — launch budget exhausted; READY after ${new Date(parked.eligibleAt).toISOString()}`
					: `REFUSED ${item} — launch budget exhausted; claim changed`,
			);
			return null;
		}
		pick = execPick(attempt, CALLER_REPO, cv, quota);
		bin = resolveLaneExecutor(pick.bin);
		if (!bin && POSTURE !== "plaid") {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — selected executor unavailable; nothing claimed or minted`,
			);
			return null;
		}
		// Plaid picks the least-loaded healthy provider. Steady uses .prefer.
		// W1102.1: the plaid preflight (host-pressure hold + pool plan +
		// route pick) moved to scripts/lib/plaid-launch.ts (1500-line law).
		if (POSTURE === "plaid") {
			const pre = await plaidLaunchPreflight({
				store,
				sids: lanes.map((l) => l.sid),
				quota,
				ordinal,
				hub: pick.hub,
				routePin: ROUTE,
				fleetDir: FLEET,
				modelHealth: PLAID_MODEL_HEALTH,
			});
			if (pre.skip) {
				console.log(`SKIP ${item} — ${pre.skip}`);
				return null;
			}
			pick = { ...pick, ...pre.pick };
			pick.preference = posturePreference(
				pick.preference,
				pick.name,
				pick.chainIdx,
			);
			// W1009.2: the route may swap the executor token (e.g. codex) —
			// resolve the binary from the MERGED pick or the launch wraps the
			// stale pre-plaid bin with the codex adapter's argv (mixed spawn).
			bin = resolveLaneExecutor(pick.bin);
			if (!bin) {
				governanceRefusals.push(item);
				console.log(
					`REFUSED ${item} — executor unavailable: ${pick.bin}; nothing claimed or minted`,
				);
				store.close();
				return null;
			}
			routeName = pre.routeName;
			if (pre.note) console.log(`NOTE — ${pre.note}`);
		}
		const route = await routeAdmission.check(pick.model);
		if (route.pause) {
			const why =
				route.reason ??
				`${pick.model} has ${route.failures} recent, exactly attributed route refusals; retry when evidence clears`;
			console.log(`WAIT ${item} — ${why}`);
			return null;
		}
		const take = run(
			workCli("take", item, "--as", sid, "--origin", `${hostname()}:claude`),
		);
		if (take.code !== 0) {
			const show = run(workCli("show", item, "--json"));
			if (show.code !== 0 || !isResumableClaim(show.out, item, sid)) {
				console.log(
					`SKIP ${item} — claim could not be taken or resumed: ${take.out.split("\n")[0]}`,
				);
				return deferItem(item, show, sid);
			}
			// claimed by this sid from a previous dispatch attempt — resume
		}
		const takeToken =
			take.code === 0
				? (/claim token: ([0-9a-f]{48})/.exec(take.out)?.[1] ?? null)
				: null;
		const claimedRow = store
			.query(
				"SELECT updated_at FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
			)
			.get(project, item, sid) as { updated_at: number } | null;
		if (!claimedRow) throw new Error("claim changed before launch preparation");
		claimRevision = claimedRow.updated_at;
		const executor = executorLaunch(adapterFor(pick.bin), bin);
		intent = reserveLaunchIntent(
			store,
			{
				project,
				item,
				sid,
				nonce,
				revision: claimRevision,
				executor: executor.bin,
			},
			limit,
			attempt - 1,
		);
		attempt = intent.attempt;
		// W620: stamp the join keys future trust folds attribute by (W105
		// parity with the board path) — model fact only when a pin exists
		recordLaneExecutor(store, sid, pick.name, pick.model);
		recordPlaidTrace(store, sid, POSTURE, routeName);

		const expected = `suspenders/${item}`;
		let cur = existsSync(wt)
			? sh(["git", "-C", wt, "branch", "--show-current"])
			: expected;
		if (!existsSync(wt)) {
			const created = run([
				process.execPath,
				`${BIN}/worktree.ts`,
				"create",
				item,
			]);
			if (created.code !== 0) {
				console.log(
					`SKIP ${item} — worktree create failed: ${created.out.split("\n")[0]}`,
				);
				return null;
			}
		} else if (cur !== expected) {
			// wrong branch = another lifecycle's tree; never spawn into it
			if (residueOf(wt)) {
				console.log(
					`SKIP ${item} — leftover worktree sits on ${cur || "(detached)"} AND is dirty — residue is never silently discarded; worktree.ts retire ${item} --force, then re-dispatch`,
				);
				return deferItem(item);
			}
			const skip = recreateWorktree(item, sid, claimRevision);
			if (skip) {
				console.log(skip);
				return null;
			}
			console.log(
				`NOTE — recreated ${wt} (was on ${cur || "(detached)"}) before spawn (W349)`,
			);
			cur = expected;
		} else if (
			!resume &&
			residueOf(wt) &&
			!(
				takeToken &&
				verifiedContextContinuation(store, {
					project,
					item,
					sid,
					token: takeToken,
					revision: claimRevision,
					tree: wt,
				})
			)
		) {
			console.log(
				`SKIP ${item} — worktree holds unbanked residue on the item branch — never spawn into unbanked state; worktree.ts retire ${item} --force, then re-dispatch`,
			);
			return deferItem(item);
		}
		const branch = cur || expected;
		const show = run(workCli("show", item));
		const capsule = capsuleGet(sid);
		// W643: dispatch output shows the capsule's reconciliation verdict —
		// operator + resumed lane see fresh/behind/diverged before the spawn.
		const capVerdict = capsule
			? capsuleValidity(capsule as Record<string, unknown>, {
					repoDir: wt,
					headSha: sh(["git", "-C", wt, "rev-parse", "HEAD"]) || null,
				}).verdict
			: "none";
		// a resumed (dead, re-dispatched) lane advances the must/prefer chain —
		// attempt N having died is exactly the signal to try chain[N+1] next
		// (owner directive 2026-10-03: sequential must/prefer, CLI-agnostic).
		if (pick.chainLen > 1)
			console.log(
				`NOTE — chain attempt ${pick.chainIdx}/${pick.chainLen - 1}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
			);
		// W293 session-name bridge: stamp the lane's user-facing name onto the
		// sessions row (tags JSON) so coord fleet + the board show e.g.
		// "[IKEA] opus W5" instead of an opaque sid. Renames on resume (the chain
		// can switch executor between attempts). The lane's own session-start
		// upsert never touches the tags column, so the name survives registration.
		const parentSid = launchParent(store, project, item);
		const registered = run(
			coordCli(
				"bootstrap",
				"--as",
				sid,
				"--name",
				`${pick.agent} ${item}`,
				"--worktree",
				wt,
				...(parentSid ? ["--parent", parentSid] : []),
			),
		);
		if (registered.code !== 0)
			throw new Error("lane session metadata registration failed");
		// W519: .prefer routing constraints ride the brief — prefer= soft,
		// must= reserved (lib/prefer-routing.ts); errors loud, never fatal.
		const resumeDecision = decisionFor(
			RESUME_FROM,
			resume?.sid,
			pick.bin ?? "claude",
		);
		const { brief, intel } = composeDispatchBrief(previewDeps, {
			item,
			show,
			sid,
			branch,
			wt,
			capsule,
			pick,
			resumeBrief: resumeBriefLine(resumeDecision),
		});
		if (intel.skip) log(`BRIEF-INTEL skip ${item}: ${intel.skip}`);
		// W223.2 dual-harness brief verification, W422-shaped: the harness id
		// and enforcement mode are ADAPTER data (registry). A failing brief on
		// a hard-gate adapter refuses the spawn AND reclaims the claim (a
		// stranded claim on a never-spawned lane is the exact disease quota-
		// sweep cures); warn-only adapters dispatch with a NOTE.
		const adapter = adapterFor(pick.bin);
		const verdict = verifyBrief(brief, { harness: adapter.briefHarness });
		if (!verdict.ok && adapter.briefHardGate) {
			const why = briefVerdictLine(verdict, Buffer.byteLength(brief));

			console.log(
				`SKIP ${item} — brief refused by ${adapter.briefHarness} verification: ${why} — launch refused; claim cleanup follows, nothing spawned`,
			);
			return deferItem(item);
		}
		if (!verdict.ok)
			console.log(
				`NOTE — ${briefVerdictLine(verdict, Buffer.byteLength(brief))} (warn-only, dispatched anyway)`,
			);
		const briefFile = `${FLEET}/brief-${sid}.md`;
		mkdirSync(FLEET, { recursive: true });
		writeFileSync(briefFile, brief);
		// W.F1 (2026-10-03): sandboxed lanes can read NOTHING outside their
		// worktree — the .fleet/brief-<sid>.md copy in the main checkout is
		// invisible to them (lesson.brief-sandbox-access; the whole [IKEA] demo
		// family produced zero bytes because of this). The worktree copy is the
		// one the lane reads; the .fleet copy stays for the orchestrator/board.
		writeFileSync(`${wt}/.klh-brief.md`, brief);
		// env + spawn recipe shared with supervise.ts per executor (W223):
		// copilot takes --allow-all-tools, claude keeps the allowedTools recipe
		const env = laneEnv(
			{ ...process.env, ...(takeToken ? { KLH_CLAIM_TOKEN: takeToken } : {}) },
			NO_BELT,
		);
		Object.assign(env, executor.env);
		env.SUSPENDERS_SID = sid;
		env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL = "canonical-v1";
		// W229 universal insertion: recipe data + one applicator (lib/insertion.ts)
		// — executor knowledge lives in the table, dispatch has no per-executor
		// branches. NO_BELT lanes speak their own API; nothing is inserted.
		// (Model pins only make sense behind belt — belt routes by model id.)
		// hub resolution (owner directive 2026-10-03): a .prefer hub= label now
		// actually redirects lane traffic — resolveHub walks env override →
		// repo one-off hub-url candidates → global hubs.json registry → mDNS
		// <label>.local guess → null (degrades to local belt/buckle, loud note,
		// never a silent wrong hub).
		let hubNote = "";
		// W483: a hub inside its stack.yaml quiet-hours window is EXPECTED to
		// vanish — place the lane on local belt instead of a host that powers
		// off mid-flight (surfaced, never silent).
		// W230: stack.yaml policies.<repo>.hub feeds the pick when the repo's
		// own .prefer carries no hub= line (dotfiles-win: the dotfile wins).
		const hubPick = pick.hub ?? policyForRepo(CALLER_REPO)?.hub ?? null;
		const hubDark = hubPick ? darkHubNow(hubPick) : false;
		if (hubDark) {
			hubNote = ` — NOTE hub=${hubPick} in quiet hours, using local belt`;
			console.log(`NOTE — hub=${hubPick} in quiet hours; using local belt`);
		}
		let resolvedHub: string | undefined;
		// W615: the hub URL rides alongside the label — attribution mints at it.
		let resolvedHubUrl: string | undefined;
		if (!NO_BELT) {
			// always pin a model — an unpinned lane inherits the owner's global
			// settings.json ANTHROPIC_DEFAULT_*_MODEL (glm-5.3[1m]) and dies on
			// client-side unrecognized_model before its first wire call
			const ctx = insertionCtx(
				env,
				pick.model ?? "glm-5.3-flash",
				pick.bin,
				tryLoadStack(),
			);
			if (hubPick && !hubDark) {
				const hub = await resolveHub(hubPick, pick.hubUrls);
				if (hub) {
					ctx.anthropicBase = hub.url;
					ctx.openaiBase = `${hub.url}/v1`;
					env.SUSPENDERS_HUB = hub.label;
					env.SUSPENDERS_HUB_VIA = hub.via;
					hubNote = ` — hub ${hub.label} -> ${hub.url} (${hub.via})`;
					resolvedHub = hub.label;
					resolvedHubUrl = hub.url;
				} else {
					hubNote = ` — NOTE hub=${hubPick} unreachable, falling back to local belt (W228-style: surfaced, never silent)`;
					console.log(`NOTE — hub=${hubPick} unreachable; using local belt`);
				}
			}
			applyInsertion(env, pick.bin, ctx);
			// W1 dispatch-side adoption (finding.w1): the lane rides the buckle
			// front with /w/<sid> so usage attributes per lane (route_audit.lane).
			// W463 fail-closed: the gate demands bksk_ keys, so a mint failure
			// REFUSES the lane — governance must not silently vanish — and only
			// the explicit --allow-ungoverned override rides belt direct.
			// W422.17: probe once — front up rides the W463 governed mint path,
			// front down branches on the governance mode (strict refuses, solo
			// keeps the belt-direct fallback). undefined = hub won, hub branch.
			// W615: a winning hub redirect NO LONGER skips attribution (the
			// identity-doc gap): the lane mints its key AT the hub and rides
			// <hub-url>/w/<sid>, so hub-routed usage lands in the hub's own
			// route_audit.lane. Credential + posture = hubAttributionDecision.
			const frontUp: string | null | undefined = resolvedHub
				? undefined
				: await probeBuckleFront();
			if (resolvedHub) {
				// W615 (lib/hub-lane.ts): mint AT the hub, ride <hub>/w/<sid> —
				// governed → env attribution + 0600 meta; override/refuse → the
				// W463 disclosure machinery, hub-worded.
				const hub = await attributeHubLane({
					sid,
					hubLabel: hubPick ?? resolvedHub,
					hubUrl: resolvedHubUrl ?? resolvedHub,
					allowUngoverned: ALLOW_UNGOVERNED,
					env,
				});
				if (hub.decision.mode === "governed") {
					ownedKeyId = hub.ownedKeyId;
					ownedKeyFront = resolvedHubUrl ?? resolvedHub;
					const meta = hub.meta as string;
					writtenFiles.set(laneKeyMetaPath(FLEET, sid), meta);
					writeFileSync(laneKeyMetaPath(FLEET, sid), meta);
					chmodSync(laneKeyMetaPath(FLEET, sid), 0o600);
					hubNote += ` — lane attribution: hub ${resolvedHub} /w/${sid} (scoped key, ttl ${LANE_KEY_TTL_S}s)`;
				} else if (hub.decision.mode === "ungoverned-override") {
					console.log(`*** ${hub.decision.note} ***`);
					hubNote += ` — ${hub.decision.note}`;
					// W463: the override is disclosed IN the brief the lane reads.
					discloseInBrief(brief, briefFile, wt, hub.decision.note);
				} else {
					governanceRefusals.push(item);
					console.log(
						`REFUSED ${item} — ${hub.decision.why}; launch refused; claim cleanup follows, nothing spawned`,
					);
					log(`REFUSED ${item} → ${sid} — ${hub.decision.why}`);
					return null;
				}
			} else if (frontUp) {
				const decision = laneKeyDecision(
					await ensureLaneKey(sid),
					ALLOW_UNGOVERNED,
					governanceMode(),
				);
				if (decision.mode === "governed") {
					applyLaneAttribution(env, sid, undefined, decision.key);
					ownedKeyId = decision.keyId;
					const meta = `${JSON.stringify({ sid, key_id: decision.keyId, mintedAt: Date.now() }, null, 2)}\n`;
					writtenFiles.set(laneKeyMetaPath(FLEET, sid), meta);
					writeFileSync(laneKeyMetaPath(FLEET, sid), meta);
					chmodSync(laneKeyMetaPath(FLEET, sid), 0o600);
					hubNote += ` — lane attribution: buckle front /w/${sid} (scoped key, ttl ${LANE_KEY_TTL_S}s)`;
				} else if (decision.mode === "ungoverned-override") {
					console.log(`*** ${decision.note} ***`);
					hubNote += ` — ${decision.note}`;
					// W463: the override is disclosed IN the brief the lane reads.
					discloseInBrief(brief, briefFile, wt, decision.note);
				} else {
					governanceRefusals.push(item);
					console.log(
						`REFUSED ${item} — ${decision.why}; launch refused; claim cleanup follows, nothing spawned`,
					);
					log(`REFUSED ${item} → ${sid} — ${decision.why}`);
					return null;
				}
			} else if (frontUp !== undefined) {
				// W422.17 probe-false, W1119.2: an unreachable front refuses the
				// lane in BOTH modes — solo relents nowhere (single-buckle-inference).
				const probe = probeFrontDecision(ALLOW_UNGOVERNED, governanceMode());
				if (probe.mode === "refuse") {
					governanceRefusals.push(item);
					console.log(
						`REFUSED ${item} — ${probe.why}; launch refused; claim cleanup follows, nothing spawned`,
					);
					log(`REFUSED ${item} → ${sid} — ${probe.why}`);
					return null;
				}
				console.log(`NOTE — ${probe.note}`);
				hubNote += ` — ${probe.note}`;
				// ungoverned rides are disclosed IN the brief the lane reads.
				discloseInBrief(brief, briefFile, wt, probe.note);
			}
		} else {
			// W1119.2: --no-belt retired as an explicit UNGOVERNED override (W463).
			const note = noBeltNote();
			console.log(`*** ${note} ***`);
			hubNote += ` — ${note}`;
			discloseInBrief(brief, briefFile, wt, note);
		}
		// W432: the prompt points at the READABLE copy — sandboxed lanes read
		// nothing outside their worktree (W.F1 above), so the canonical
		// .fleet/brief-<sid>.md is invisible to them. The .fleet copy stays for
		// the orchestrator/board; the worktree copy is what the lane actually gets.
		const prompt = `Lane ${sid}. Read ${wt}/.klh-brief.md (your readable worktree copy of the mission brief — canonical: ${briefFile}) and execute it fully.`;
		// W454 starter sessions (W1124.12.1: default OFF — SUSPENDERS_LANE_STARTER
		// =on/1 opts in): fork a versioned shared-prefix starter session
		// instead of cold orientation; the seed
		// rides a fleet identity (fleet-starter attribution slug), never the
		// lane's minted key. Wiring lives in scripts/lib/lane-starter.ts.
		const {
			forkArgs: starterFork,
			prompt: lanePrompt,
			seedError,
			starter,
		} = await dispatchStarterFork({
			env,
			noBelt: NO_BELT,
			harness: pick.bin ?? "claude",
			fleet: FLEET,
			bin,
			model: pick.model ?? "glm-5.3-flash",
			item,
			sid,
			wt,
			coldPrompt: prompt,
			log,
		});
		if (seedError) {
			const detail = `${seedError.phase}, code ${seedError.code}${seedError.preflight ? `, ${seedError.preflight}` : ""}: ${seedError.stderrTail}`;
			console.log(`SEED FAILED ${item} — ${detail}`);
			log(`SEED FAILED ${item} → ${sid} — ${detail}`);
			seedFallbacks.push(`${item} (${detail})`);
		}
		// W622 retake knob: an honored --resume-from outranks the starter
		// fork — the lane continues the prior transcript as a NEW session
		// (--fork-session leaves pass 1's transcript immutable). Any missed
		// fence stays on the fresh path, disclosed.
		const laneForkArgs =
			resumeDecision.mode === "resume" ? resumeDecision.forkArgs : starterFork;
		if (resumeDecision.mode === "resume")
			console.log(
				`NOTE — transcript resume ${resumeDecision.sid} (claude --resume --fork-session; fences held)`,
			);
		else if (RESUME_FROM)
			console.log(
				`NOTE — --resume-from refused: ${resumeDecision.why}; fresh lane + capsule`,
			);
		// W818: the lane's start mode rides BOTH surfaces — dispatch output and
		// the lane log — so a forked or cold start is explainable from either.
		if (starter) {
			const starterLine = starterStartLine(item, starter);
			console.log(starterLine);
			appendFileSync(laneLog, `${starterLine}\n`);
		}
		// settings.json env CLOBBERS the process env at CLI startup (probed live
		// 2026-10-05: a lane pinned to glm-5.3-flash still resolved glm-5.3[1m]).
		// --settings outranks user settings: write the lane-critical vars and pass
		// the file on the CLI layer. 0600 — it carries the lane token.
		// W512: the Task layer joins the same file as a hooks block — subagent
		// requests get the pinned model injected at call time (PreToolUse
		// updatedInput), the one channel no settings-env merge can clobber.
		const laneSettings = `${FLEET}/lane-settings-${sid}.json`;
		const m = pick.model ?? "glm-5.3-flash";
		const settingsData = laneSettingsData(
			env,
			m,
			BIN,
			dispatchLaneEffort(store, project, item),
			pick.preference,
			ROUTING_PREFER,
		);
		writtenFiles.set(laneSettings, settingsData);
		writeFileSync(laneSettings, settingsData);
		chmodSync(laneSettings, 0o600);
		const settingsArgs = ["--settings", laneSettings];
		// Immutable evidence base survives resumes and later main-branch merges.
		const completionContext = `${wt}/.fleet/lane-context.json`;
		mkdirSync(`${wt}/.fleet`, { recursive: true });
		if (takeToken) {
			// W643: merge the fresh take token into the activation context —
			// create-with-baseline when absent, token-only merge when it exists
			// (a re-take after a reclaim refreshes the token, never the baseline).
			const prior = existsSync(completionContext)
				? (JSON.parse(readFileSync(completionContext, "utf8")) as Record<
						string,
						unknown
					>)
				: null;
			writeFileSync(
				completionContext,
				JSON.stringify(
					prior
						? { ...prior, claimToken: takeToken }
						: {
								sid,
								item,
								baseline: sh(["git", "-C", wt, "rev-parse", "HEAD"]),
								launchedAt: Date.now(),
								claimToken: takeToken,
							},
				),
			);
		} else if (!existsSync(completionContext))
			writeFileSync(
				completionContext,
				JSON.stringify({
					sid,
					item,
					baseline: sh(["git", "-C", wt, "rev-parse", "HEAD"]),
					launchedAt: Date.now(),
				}),
			);
		if (
			!store
				.query(
					"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(project, item, sid, claimRevision)
		)
			throw new Error("claim changed before executor spawn");
		if (!renewLaunchLease(store, project, sid, nonce))
			throw new Error("launch lease replaced before spawn");
		const proc = spawnClaude({
			bin: fencedExecutor(FLEET, intent),
			prompt: lanePrompt,
			cwd: wt,
			logFile: laneLog,
			env,
			// W422: the spawn tail is the executor adapter's recipe (registry) —
			// copilot gets --allow-all-tools, claude the allowedTools/fallback/
			// settings/fork composition; dispatch carries no executor branches.
			promptArgs: adapter.promptArgs(lanePrompt),
			promptLast: adapter.promptLast === true,
			cliArgs: adapter.spawnArgs({
				fallbackModels: pick.fallbackModels,
				settingsArgs,
				forkArgs: laneForkArgs,
			}),
			fleetDir: FLEET,
			sid,
		});
		launchedProc = proc;
		await awaitLaunchRegistration(store, FLEET, intent, proc);
		store
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
			)
			.run(attemptKey, String(attempt), "dispatch", Date.now());
		// This only rejects immediate startup failure; it is not a health proof.
		const earlyExit = await Promise.race([
			proc.exited,
			Bun.sleep(1000).then(() => null),
		]);
		if (earlyExit !== null)
			throw new Error(
				`executor exited during launch (code ${earlyExit}); inspect ${laneLog}`,
			);
		proc.unref();
		const slab = laneClassOf(pick.agent ?? "claude");
		const js = jobslabFor(slab, FLEET);
		const entry: Lane = {
			sid,
			item,
			pid: proc.pid,
			branch,
			worktree: wt,
			agent: pick.agent,
			host: hostname(),
			hub: resolvedHub,
			slab,
			launchedAt: Date.now(),
			attempt,
			...(seedError ? { seedError } : {}),
		};
		// Accept the launch only after its PID and ownership are durable.
		if (!renewLaunchLease(store, project, sid, nonce))
			throw new Error("launch lease replaced before registry persistence");
		assertLaunchClaim(store, intent, true);
		saveLanes([entry]);
		lanes.push(entry);
		committedLaunch = true;
		log(
			`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch}, slab ${jobslabTag(slab, js)})${hubNote}`,
		);
		console.log(
			`dispatched ${item} → ${sid} (pid ${proc.pid})${capsule ? ` — resumed from capsule (${capVerdict})` : ""}${hubNote}`,
		);
		return `${item}→${sid}(pid ${proc.pid})`;
	} catch (error) {
		governanceRefusals.push(item);
		const backoff =
			launchedProc?.exitCode !== null && launchedProc !== undefined
				? scheduleLaunchBackoff(store, project, item, laneLog, attempt)
				: null;
		console.log(
			`REFUSED ${item} — launch failed: ${String(error)}${backoff ? `; ${backoff.kind} retry after ${new Date(backoff.eligibleAt).toISOString()}` : ""}`,
		);
		log(`REFUSED ${item} → ${sid} — launch failed: ${String(error)}`);
		return null;
	} finally {
		await launchCleanup({
			committedLaunch,
			store,
			project,
			sid,
			item,
			nonce,
			launchedProc,
			intent,
			claimRevision,
			ownedKeyId,
			ownedKeyFront,
			hub: pick.hub,
			writtenFiles,
			log,
		});
	}
};

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
		const out = await dispatchItem(resume.item, live, resume);
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
			const out = await dispatchItem(ITEM, live, explicitResume);
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
		const out = await dispatchItem(r.id, live, undefined, dispatched.length);
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
