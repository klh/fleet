// fleet-loop/dispatch.ts — the `dispatch` verb: one Work Graph item →
// claimed, worktree, briefed headless lane. The fleet's own spawner — the
// coordinator dispatches a single item; the loop's pid guard, lanes verb,
// and retire lifecycle cover the result.
// (W740 split: block body verbatim from the entrypoint; the dialect wire
// path anchors at the entrypoint's binDir, not import.meta.dir.)

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { symlinkBuildDirs } from "../builddirs.ts";
import { openStore, projectIdentity } from "../govdb/govdb.ts";
import { mergeLaneRegistry } from "../lanes/lane-registry.ts";
import { laneSid } from "../lanes/laneslug.ts";
import { laneProcessIdentity } from "../lanes/lane-liveness.ts";
import { condensePrompt } from "../../board/prompt-transform.ts";
import {
	jobslabFor,
	jobslabPrefix,
	jobslabTag,
	laneClassOf,
} from "../lanes/jobslab.ts";
import {
	acquireLaunchLease,
	releaseFailedLaunch,
	releaseLaunchLease,
	selectLaneCarrier,
} from "../../../scripts/lib/launch-preflight.ts";
import {
	assertLaunchClaim,
	awaitLaunchRegistration,
	fencedExecutor,
	finishFailedLaunch,
	inspectLaunchIntent,
	launchIntent,
	nextReservedAttempt,
	reserveLaunchIntent,
	terminateOwnLaunch,
	type LaunchIntent,
} from "../../../scripts/lib/launch-fencing.ts";
import { launchParent } from "../lanes/launch-parent.ts";
import { laneAttemptLimit } from "../lanes/lane-retry-budget.ts";
import {
	parkExhaustedLaunch,
	readLaunchBackoff,
	scheduleLaunchBackoff,
} from "../../../scripts/lib/launch-backoff.ts";
import { reproGateForItem } from "../gates/repro-gate.ts";
import { recordLaneExecutor } from "../executors/executor-cv.ts";
import { adapterFor } from "../executors/registry.ts";
import {
	applyLaneAttribution,
	executorLaunch,
	probeBuckleFront,
} from "../lanes/lane.ts";
import { ensureLaneKey, laneKeyMetaPath } from "../lanes/lane-auth.ts";
// W254: pointer-grade injection — file-map + done-definition digest for the
// direct-launch brief, gated per W113 on repo size (hooks/lib/lanes/brief-intel.ts)
import { briefIntel, renderIntel } from "../lanes/brief-intel.ts";
import { isResumableClaim } from "../../../scripts/lib/resumable-claim.ts";
import { flagFns, type LoopConfig } from "./config.ts";
import type { LoopDeps } from "./runtime.ts";
export async function runDispatch(
	config: LoopConfig,
	deps: Pick<LoopDeps, "log" | "sh" | "lanes">,
): Promise<void> {
	const { REPO, MAIN, AGENT, EFFORT, binDir } = config;
	const { log, sh, lanes } = deps;
	const { val } = flagFns(config.argv);
	const item = val("--item");
	if (!item) {
		console.error("dispatch requires --item <Wn>");
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
	// W831 total carrier selector: unknown/unspawnable/offline executors are
	// explicit refusals — never a silent fall-through to the wrong backend.
	const carrier = selectLaneCarrier(AGENT);
	if (!carrier.ok) {
		console.error(`REFUSED ${item} — ${carrier.why}`);
		process.exit(1);
	}
	const bin = carrier.bin;
	const executor = executorLaunch(adapterFor(AGENT), bin);
	const store = openStore(),
		project = projectIdentity(REPO),
		nonce = crypto.randomUUID();
	const laneLog = `${REPO}/.fleet/lane-${sid}.log`;
	const hold = readLaunchBackoff(store, project, item);
	if (hold && Date.now() < hold.eligibleAt) {
		console.error(
			`WAIT ${item} — ${hold.kind} launch backoff until ${new Date(hold.eligibleAt).toISOString()} (evidence ${hold.log})`,
		);
		store.close();
		process.exit(1);
	}
	// W743 repro-first gate: a re-mint of a FAILED item re-dispatches only with
	// evidence of record (repro artifact / no-repro reason / death-log exemption).
	const refusal = reproGateForItem(store, project, item);
	if (refusal) {
		console.error(`REFUSED ${item} — ${refusal}`);
		process.exit(1);
	}
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
		if (attempt >= limit) {
			const parked = parkExhaustedLaunch(
				store,
				project,
				item,
				sid,
				laneLog,
				attempt,
			);
			console.error(
				parked
					? `WAIT ${item} — launch budget exhausted; READY after ${new Date(parked.eligibleAt).toISOString()} (evidence ${parked.log})`
					: `REFUSED ${item} — launch budget exhausted; claim changed`,
			);
			releaseLaunchLease(store, project, sid, nonce);
			store.close();
			process.exit(1);
		}
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
		// W643: capture the take-minted claim token; rides the lane env (the
		// direct-launch brief has no context bank — env is the channel here).
		const takeToken =
			take.code === 0
				? (/claim token: ([0-9a-f]{48})/.exec(take.out)?.[1] ?? null)
				: null;
		const claim = store
			.query(
				"SELECT updated_at FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
			)
			.get(project, item, sid) as { updated_at: number } | null;
		if (!claim) throw new Error("claim changed during direct launch");
		revision = claim.updated_at;
		// W1731: register the explicit launch identity (lane-launch parity) —
		// completion reads it before ambient client detection, which a nested
		// agent's inherited environment can mislead.
		recordLaneExecutor(store, sid, AGENT, null);
		intent = reserveLaunchIntent(
			store,
			{ project, item, sid, nonce, revision, executor: executor.bin },
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
		// W254: pointer-grade injection into the board-spawned brief too — the
		// gates log their own skips (dispatchers log it, never silent).
		const intel = briefIntel(REPO, `${item} ${show.out}`);
		if (intel.skip) log(`BRIEF-INTEL skip ${item}: ${intel.skip}`);
		const intelLines = renderIntel(intel);
		// W304.1 — deterministic condense (W270 prose-only ruleset) on the free-text
		// portions of the brief; code fences/paths/flags are protected verbatim by
		// condensePrompt itself, so mission/inbox prose shrinks without losing the
		// technical surface the lane actually has to act on.
		const brief = [
			`You are lane "${sid}", Work Graph item ${item}, repo ${REPO}.`,
			``,
			`MISSION (from work show):`,
			condensePrompt(show.out),
			...(intelLines.length ? [``, ...intelLines] : []),
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
		const env = { ...process.env, ...executor.env };
		if (takeToken) env.KLH_CLAIM_TOKEN = takeToken;
		delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
		if (AGENT !== "codex") {
			env.SUSPENDERS_SID = sid;
			env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL = "canonical-v1";
		}
		// W1119.2 single-buckle-inference: a fleet-loop lane rides the buckle
		// front attributed — probe + scoped-key mint fail CLOSED (no solo/
		// ungoverned bypass on this verb): a miss throws into the catch below
		// (REFUSED; the finally releases the claim back to READY).
		const buckleFront = await probeBuckleFront();
		if (!buckleFront)
			throw new Error(
				"buckle front unreachable — lanes dispatch only through the buckle front (single-buckle-inference W1119)",
			);
		const minted = await ensureLaneKey(sid);
		if (!minted)
			throw new Error(
				"buckle lane-key mint failed — check belt.env BUCKLE_ADMIN_KEY (fail-closed W463)",
			);
		applyLaneAttribution(env, sid, undefined, minted.key);
		const keyMeta = laneKeyMetaPath(`${REPO}/.fleet`, sid);
		writeFileSync(
			keyMeta,
			`${JSON.stringify({ sid, key_id: minted.keyId, mintedAt: Date.now() }, null, 2)}\n`,
		);
		chmodSync(keyMeta, 0o600);
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
		} else if (AGENT === "copilot") {
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
		// W1811: grok/cline retired from dispatch until transcript evidence
		// readers land — their dialect wiring stays (hooks/dialects/) but no
		// dispatch path can launch an evidence-blind lane.
		const WIRE_BY_AGENT: Record<string, string> = {
			codex: "codex",
			copilot: "copilot",
		};
		const wireDialect = WIRE_BY_AGENT[AGENT];
		if (wireDialect) {
			const wire = Bun.spawnSync(
				[process.execPath, `${binDir}/../dialects/${wireDialect}/wire.ts`],
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
		if (earlyExit !== null) {
			const backoff = scheduleLaunchBackoff(
				store,
				project,
				item,
				laneLog,
				attempt,
			);
			console.error(
				`WAIT ${item} — ${backoff.kind} launch retry after ${new Date(backoff.eligibleAt).toISOString()} (evidence ${laneLog})`,
			);
			throw new Error(`executor exited during launch (code ${earlyExit})`);
		}
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
