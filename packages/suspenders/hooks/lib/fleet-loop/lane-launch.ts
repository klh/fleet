// lane-launch.ts — THEN.D (W1255.6): the per-lane dispatch loop body, moved
// verbatim from scripts/dispatch-next.ts so hooks/lib/fleet-loop owns the
// launch machine and the entrypoint keeps only the CLI face + refill
// orchestration. W928 pattern: the entrypoint's REPO/CLI-bound closures and
// run-config constants arrive as one deps bag and are destructured at the
// top — the body below is byte-verbatim from the entrypoint.
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
	briefVerdictLine,
	verifyBrief,
} from "../../../scripts/lib/brief-verify.ts";
import {
	type DispatchLane as Lane,
	parseCapsuleGet,
	type RouteAdmission,
} from "../../../scripts/lib/dispatch-admission.ts";
import { deferItem } from "../../../scripts/lib/dispatch-defers.ts";
import {
	type ChosenExecutor,
	chosenExecutor,
	chosenExecutorLine,
	laneModelOf,
} from "../../../scripts/lib/dispatch-executor-note.ts";
import {
	composeDispatchBrief,
	type DispatchPreviewDeps,
	dryDispatchPreview,
} from "../../../scripts/lib/dispatch-preview.ts";
import {
	execPick,
	posturePreference,
} from "../../../scripts/lib/exec-chain.ts";
import {
	laneKeyDecision,
	probeFrontDecision,
} from "../../../scripts/lib/governance-decide.ts";
import { attributeHubLane } from "../../../scripts/lib/hub-lane.ts";
import {
	applyInsertion,
	insertionCtx,
} from "../../../scripts/lib/insertion.ts";
import { laneSettingsData } from "../../../scripts/lib/lane-settings.ts";
import {
	dispatchStarterFork,
	starterStartLine,
} from "../../../scripts/lib/lane-starter.ts";
import {
	parkExhaustedLaunch,
	readLaunchBackoff,
	scheduleLaunchBackoff,
} from "../../../scripts/lib/launch-backoff.ts";
import { launchCleanup } from "../../../scripts/lib/launch-cleanup.ts";
import {
	assertLaunchClaim,
	awaitLaunchRegistration,
	fencedExecutor,
	inspectLaunchIntent,
	type LaunchIntent,
	launchIntent,
	nextReservedAttempt,
	readConfiguredLaunches,
	reserveLaunchIntent,
} from "../../../scripts/lib/launch-fencing.ts";
import {
	acquireLaunchLease,
	renewLaunchLease,
	resolveLaneExecutor,
} from "../../../scripts/lib/launch-preflight.ts";
import { plaidLaunchPreflight } from "../../../scripts/lib/plaid-launch.ts";
import type { PreferRouting } from "../../../scripts/lib/prefer-routing.ts";
import { isResumableClaim } from "../../../scripts/lib/resumable-claim.ts";
import {
	decisionFor,
	resumeBriefLine,
} from "../../../scripts/lib/resume-from.ts";
import { verdictRepeatGate } from "../../../scripts/lib/verdict-repeat-gate.ts";
import { capsuleValidity } from "../capsule-fence.ts";
import {
	cvMap,
	executorCv,
	recordLaneExecutor,
	writeExecutorCvFacts,
} from "../executors/executor-cv.ts";
import { launchToken } from "../executors/detect.ts";
import { adapterFor } from "../executors/registry.ts";
import { openStore, projectIdentity } from "../govdb/govdb.ts";
import { resolveHub } from "../hub/hub-locate.ts";
import { jobslabFor, jobslabTag, laneClassOf } from "../lanes/jobslab.ts";
import {
	applyLaneAttribution,
	executorLaunch,
	laneEnv,
	probeBuckleFrontVerdict,
	recreateWorktreeFor,
	residueOf,
	spawnClaude,
} from "../lanes/lane.ts";
import {
	ensureLaneKey,
	LANE_KEY_TTL_S,
	laneKeyMetaPath,
} from "../lanes/lane-auth.ts";
import { dispatchLaneEffort } from "../lanes/lane-effort-policy.ts";
import { laneProcessIdentity } from "../lanes/lane-liveness.ts";
import {
	laneAttemptLimit,
	nextLaneAttempt,
} from "../lanes/lane-retry-budget.ts";
import { laneSid as sidOf } from "../lanes/laneslug.ts";
import { launchParent } from "../lanes/launch-parent.ts";
import { verifiedContextContinuation } from "../lanes/reclaim-context.ts";
import { type Posture, recordPlaidTrace } from "../plaid/plaid.ts";
import { policyBriefLines } from "../session-policy.ts";
import { darkHubNow, policyForRepo, tryLoadStack } from "../stack-config.ts";
import { quotaProviderPenalty } from "../usage/exec-quota.ts";

/** The entrypoint-bound closures + run-config the launch machine consumes.
 *  Mutable cycle collectors (refusal/wait/seed arrays) are shared references
 *  — dispatchLane pushes, the entrypoint's summary reads them. */
export type LaneLaunchDeps = {
	REPO: string;
	CALLER_REPO: string;
	FLEET: string;
	BIN: string;
	DRY: boolean;
	ROUTE?: string;
	NO_BELT: boolean;
	ALLOW_UNGOVERNED: boolean;
	RESUME_FROM?: string;
	POSTURE: Posture;
	PLAID_MODEL_HEALTH: Map<string, string | null> | null | undefined;
	ROUTING_PREFER: PreferRouting;
	governanceRefusals: string[];
	launchWaits: string[];
	seedFallbacks: string[];
	/** W1353: one row per lane launched/previewed — the run tail's executor table. */
	chosenExecutors?: ChosenExecutor[];
	governanceMode: () => "strict" | "solo";
	routingExtra: () => string[];
	itemCapsuleGet: (item: string) => Record<string, string> | null;
	/** W1295: `--role` agent-rules override; absent = composer auto-selects. */
	role?: string;
	routeAdmission: RouteAdmission;
	sh: (cmd: string[], cwd?: string) => string;
	run: (cmd: string[], cwd?: string) => { code: number; out: string };
	workCli: (...args: string[]) => string;
	coordCli: (...args: string[]) => string;
	log: (msg: string) => void;
	loadLanes: () => Lane[];
	saveLanes: (lanes: Lane[]) => void;
};

// — verbatim body (W928-style move from dispatch-next.ts) below —
/** one item → claim, worktree, brief, daemonized lane. Returns the summary
 *  fragment or null when the item cannot be taken (claimed elsewhere). */

export const dispatchLane = async (
	d: LaneLaunchDeps,
	item: string,
	lanes: Lane[],
	resume?: Lane,
	/** position in this dispatch cycle — plaid's round-robin ordinal */
	ordinal = 0,
): Promise<string | null> => {
	const {
		REPO,
		CALLER_REPO,
		FLEET,
		BIN,
		DRY,
		ROUTE,
		NO_BELT,
		ALLOW_UNGOVERNED,
		RESUME_FROM,
		POSTURE,
		PLAID_MODEL_HEALTH,
		ROUTING_PREFER,
		governanceRefusals,
		launchWaits,
		seedFallbacks,
		chosenExecutors,
		governanceMode,
		routingExtra,
		itemCapsuleGet,
		role,
		routeAdmission,
		sh,
		run,
		workCli,
		coordCli,
		log,
		loadLanes,
		saveLanes,
	} = d;
	const capsuleGet = (sid: string): Record<string, string> | null =>
		parseCapsuleGet(sh(coordCli("capsule", "get", "--as", sid)));
	const policyBriefExtra = (project: string): string[] => {
		const db = openStore();
		try {
			return policyBriefLines(db, project);
		} finally {
			db.close();
		}
	};
	const recreateWorktree = (
		item: string,
		owner: string,
		revision: number,
	): string | null => recreateWorktreeFor(item, BIN, owner, revision);
	const previewDeps: DispatchPreviewDeps = {
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
		ROUTING_PREFER,
		plaid: POSTURE === "plaid",
		...(chosenExecutors ? { chosenExecutors } : {}),
		...(role ? { role } : {}),
	};
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
		// parity with the board path) — model fact only when a pin exists.
		// W1731: the executor token must read back as the SPAWNED adapter —
		// completion picks the transcript evidence reader from it.
		recordLaneExecutor(
			store,
			sid,
			launchToken(pick.name, pick.bin),
			pick.model,
		);
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
				laneModelOf(pick),
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
			// W1: lanes ride the buckle front /w/<sid> (route_audit.lane). W463
			// fail-closed: a mint failure REFUSES the lane — governance never
			// silently vanishes; only --allow-ungoverned rides belt direct.
			// W422.17: probe once — front up rides the governed mint path, front
			// down branches on governance mode (strict refuses, solo belt-direct);
			// W1124.43: the verdict (timeout|status|unreachable) rides the note.
			// undefined = hub won. W615: a winning hub redirect still mints AT
			// the hub (<hub-url>/w/<sid>). Credential + posture = hubAttributionDecision.
			const frontProbe = resolvedHub ? null : await probeBuckleFrontVerdict();
			const frontUp = resolvedHub ? undefined : frontProbe.front;
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
					const disclosed = `${brief}\n\nGOVERNANCE: ${hub.decision.note}.\n`;
					writeFileSync(briefFile, disclosed);
					writeFileSync(`${wt}/.klh-brief.md`, disclosed);
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
					const disclosed = `${brief}\n\nGOVERNANCE: ${decision.note}.\n`;
					writeFileSync(briefFile, disclosed);
					writeFileSync(`${wt}/.klh-brief.md`, disclosed);
				} else {
					governanceRefusals.push(item);
					console.log(
						`REFUSED ${item} — ${decision.why}; launch refused; claim cleanup follows, nothing spawned`,
					);
					log(`REFUSED ${item} → ${sid} — ${decision.why}`);
					return null;
				}
			} else if (frontUp !== undefined) {
				// W422.17 probe-false: the buckle front did not answer. Strict (the
				// default) refuses the lane with the same machinery as a mint
				// failure; solo keeps the belt-direct fallback — loud, disclosed.
				const probe = probeFrontDecision(
					ALLOW_UNGOVERNED,
					governanceMode(),
					frontProbe?.note,
				);
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
				const disclosed = `${brief}\n\nGOVERNANCE: ${probe.note}.\n`;
				writeFileSync(briefFile, disclosed);
				writeFileSync(`${wt}/.klh-brief.md`, disclosed);
			}
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
			model: laneModelOf(pick),
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
		const m = laneModelOf(pick);
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
		const chosen = chosenExecutor({
			item,
			pick,
			hub: resolvedHub ?? null,
			route: routeName,
			routing: ROUTING_PREFER,
			repo: CALLER_REPO,
		});
		chosenExecutors?.push(chosen);
		console.log(chosenExecutorLine(chosen));
		if (chosen.warn) console.log(chosen.warn);
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
