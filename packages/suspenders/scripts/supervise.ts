#!/usr/bin/env bun
// supervise.ts — W146: the shattering planner becomes its subtree's
// MICRO-SUPERVISOR. Coordinator responsibilities, scoped to one parent
// item's descendants: dispatch READY children (W145 lane-spawn machinery,
// shared via hooks/lib/lane.ts), watch the graph, dispatch newly-unblocked
// children in dependency order (`work ready` IS the dep-order source — the
// W60 dep-merge gate keeps a child out of the pool until its deps are DONE
// and merged), integrate DONE children per the plan contract (verify the
// result sha is an ancestor of main, or merge the child branch with
// --integrate=merge), and close the parent when the subtree is terminal +
// integrated — the graph's roll-up usually marks the parent DONE first; the
// supervisor then records the integration evidence (fact + capsule).
//
// Scope isolation: a supervisor may only act on items under its parent —
// inScope() walks the parent chain before EVERY dispatch/close action;
// anything else is refused. Escalation goes UP, never sideways: conflicts,
// FAILED children, unmergeable branches, and dead-lane loops surface as
// `coord emit NEED_DECISION --to <its coordinator>` — never silently wait.
//
// State machine (idempotent — a restarted supervisor reads the graph,
// capsules, and journal and continues; graph state is the only truth):
//   shatter → dispatch(ready children) → watch(poll graph + inbox)
//   → unblock/integrate(dep order) → close(parent done)
//
//   bun scripts/supervise.ts <parent-id> [titles...] [--target N]
//       [--integrate verify|merge] [--to <coordinator sid>]
//       [--plan <itemId>] [--repo <dir>] [--dry-run] [--once] [--poll-ms ms]
//
//   titles...  — when the parent has no children yet, shatter it first
//                (1-2 children free; >2 needs --plan per the W16 split gate)
import type { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { flagIntegratedCode } from "../hooks/lib/decomposition.ts";
import { openStore } from "../hooks/lib/govdb.ts";
import { laneAlive } from "../hooks/lib/lane-liveness.ts";
import { supSid } from "../hooks/lib/laneslug.ts";
import {
	composeBrief,
	isOwnerGated,
	itemCapsuleGet,
	parseCapsuleGet,
	parseReady,
	sidOf,
} from "./dispatch-next.ts";
// W177: the resolved slab class is stamped into the lanes.json entry.
import { laneClassOf } from "../hooks/lib/jobslab.ts";
import {
	type Lane,
	laneEnv,
	loadLanes,
	saveLanes,
	spawnClaude,
	worktreeLive,
} from "../hooks/lib/lane.ts";
import { laneAttemptLimit } from "../hooks/lib/lane-retry-budget.ts";
import {
	assertLaunchClaim,
	awaitLaunchRegistration,
	fencedExecutor,
	finishFailedLaunch,
	heldLaunchItems,
	inspectLaunchIntent,
	type LaunchIntent,
	launchIntent,
	nextReservedAttempt,
	reserveLaunchIntent,
	terminateOwnLaunch,
} from "./lib/launch-fencing.ts";
// W576.1: launch + recovery ride the shared governed authorities — the W572
// launch fence and its per-sid lease, shared budget and CAS cleanup.
import {
	acquireLaunchLease,
	releaseFailedLaunch,
	releaseLaunchLease,
	renewLaunchLease,
	resolveLaneExecutor,
} from "./lib/launch-preflight.ts";
// W519: .prefer prefer= soft routing rides every (re)brief, resume included
import {
	preferRoutingBriefLines,
	resolveRoutingPrefer,
} from "./lib/prefer-routing.ts";
import { isResumableClaim } from "./lib/resumable-claim.ts";

/** scope isolation: itemId is the root itself or its parent chain reaches
 *  the root — children, grandchildren, any depth. Reads only; every
 *  dispatch/close action calls this FIRST. */
export const inScope = (
	db: Database,
	project: string,
	root: string,
	itemId: string,
	maxDepth = 64,
): boolean => {
	let cur: string | null = itemId;
	for (let i = 0; i < maxDepth && cur; i++) {
		if (cur === root) return true;
		const row = db
			.query("SELECT parent_id FROM work_items WHERE project = ? AND id = ?")
			.get(project, cur) as { parent_id: string | null } | undefined;
		cur = row?.parent_id ?? null;
	}
	return false;
};

const USAGE = `usage: bun scripts/supervise.ts <parent-id> [titles...] [--target N] [--integrate verify|merge] [--to <coordinator sid>] [--plan <itemId>] [--repo <dir>] [--dry-run] [--once] [--poll-ms ms]`;

const main = async (): Promise<void> => {
	const argv = process.argv.slice(2);
	const val = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const VAL_FLAGS = new Set([
		"--target",
		"--integrate",
		"--to",
		"--plan",
		"--repo",
		"--poll-ms",
		"--grace-ms",
	]);
	const pos: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (VAL_FLAGS.has(argv[i])) {
			i++;
			continue;
		}
		if (!argv[i].startsWith("--")) pos.push(argv[i]);
	}
	const PARENT = pos[0];
	// W643: the claim token of the parent claim this supervisor opened —
	// captured at take, presented at the parent close (work done --token).
	let parentToken: string | null = null;
	const TITLES = pos.slice(1);
	const die = (msg: string, code = 1): never => {
		console.error(msg);
		process.exit(code);
	};
	if (!PARENT || TITLES.includes("")) die(USAGE);
	const REPO = val("--repo") ?? process.cwd();
	const DRY = argv.includes("--dry-run");
	const ONCE = argv.includes("--once");
	const TARGET = Number(val("--target") ?? 3);
	const POLL = Number(val("--poll-ms") ?? 30000);
	// --grace-ms is retired: the durable launch intent's tri-state verdict
	// (unknown holds, W572) subsumes the post-spawn grace window; the flag
	// stays parseable for existing callers and tests.
	const INTEGRATE = val("--integrate") ?? "verify";
	if (!["verify", "merge"].includes(INTEGRATE))
		die(`--integrate must be verify|merge`);
	const PLAN = val("--plan");
	const FLEET = `${REPO}/.fleet`;
	const BIN = `${process.env.HOME}/.claude/hooks/suspenders/bin`;
	const JOURNAL_PATH = `${FLEET}/supervise-${PARENT}.json`;
	// W614: via the canonical slug lib — the inline dot-strip collapsed
	// W1.23 and W12.3 to the same supervisor sid, the exact lane-sid bug class.
	const SUP = supSid(PARENT);
	const pl = PARENT.toLowerCase();

	const gitOut = (args: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", REPO, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	};
	const commonDir = gitOut(["rev-parse", "--git-common-dir"]);
	if (!commonDir) die(`not a git repo: ${REPO}`);
	const PROJECT = realpathSync(resolve(REPO, commonDir));
	const DB_PATH = `${process.env.HOME}/.cache/claude-governor/governor.db`;
	if (!existsSync(DB_PATH))
		die(`no governor db at ${DB_PATH} — bootstrap the control plane first`);
	const db = openStore();

	type Item = {
		id: string;
		parent_id: string | null;
		state: string;
		owner_sid: string | null;
		result_sha: string | null;
		title: string;
		required: number;
		created_by: string | null;
	};
	const getItem = (id: string): Item | null =>
		(db
			.query(
				"SELECT id, parent_id, state, owner_sid, result_sha, title, required, created_by FROM work_items WHERE project = ? AND id = ?",
			)
			.get(PROJECT, id) as Item | undefined) ?? null;
	const descendants = (root: string): Item[] =>
		db
			.query(
				`WITH RECURSIVE sub AS (
					SELECT project, id, parent_id, state, owner_sid, result_sha, title, required FROM work_items WHERE project = ? AND id = ?
					UNION ALL
					SELECT w.project, w.id, w.parent_id, w.state, w.owner_sid, w.result_sha, w.title, w.required
					FROM work_items w JOIN sub s ON w.parent_id = s.id AND w.project = s.project
				) SELECT id, parent_id, state, owner_sid, result_sha, title, required FROM sub WHERE id != ?`,
			)
			.all(PROJECT, root, root) as Item[];

	const run = (cmd: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
		};
	};
	const sh = (cmd: string[]): string => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
	};
	const cli = (bin: string, ...args: string[]): { code: number; out: string } =>
		run([process.execPath, `${BIN}/${bin}`, ...args]);
	const headSha = (): string => gitOut(["rev-parse", "HEAD"]) || "none";
	// W60 semantics: exit 0 = ancestor of main, exit 1 = NOT, >1 = cannot
	// know — only a verified negative gates, never a lookup failure.
	const shaOnMain = (sha: string): boolean | null => {
		const r = Bun.spawnSync(
			["git", "-C", REPO, "merge-base", "--is-ancestor", sha, "main"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		return r.exitCode === 0 ? true : r.exitCode === 1 ? false : null;
	};

	// crash-safe journal: escalation + resume dedupe across restarts (graph
	// state is the truth; this only stops repeat NEED_DECISION spam)
	// W576.1: retry accounting left the journal — the durable launch budget
	// (lane_launch_budgets) is the ONE per-item authority, shared with
	// dispatch-next and fleet-loop dispatch; only escalation dedupe stays.
	type Journal = {
		escalated: Record<string, string>;
	};
	const loadJournal = (): Journal => {
		try {
			return JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Journal;
		} catch {
			return { escalated: {} };
		}
	};
	const journal: Journal = DRY ? { escalated: {} } : loadJournal();
	const saveJournal = (): void => {
		if (DRY) return;
		mkdirSync(FLEET, { recursive: true });
		writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
	};

	const it = getItem(PARENT);
	if (!it) die(`unknown item ${PARENT} in project ${PROJECT}`);
	const TO = val("--to") ?? it.created_by ?? "owner";

	const fact = (key: string, text: string): void => {
		if (DRY) return;
		cli("coord.ts", "fact", "set", key, "--text", text, "--source", SUP);
	};
	const bankCapsule = (done: string, next: string): void => {
		if (DRY) return;
		cli(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			SUP,
			`--checkpoint=${headSha()}`,
			"--file=scripts/supervise.ts",
			`--done=${done}`,
			`--next=${next}`,
		);
	};
	const escalate = (kind: string, msg: string): void => {
		if (journal.escalated[kind]) return;
		console.log(`NEED_DECISION [${kind}] → @${TO}: ${msg}`);
		if (DRY) return;
		const r = cli(
			"coord.ts",
			"emit",
			"NEED_DECISION",
			"--to",
			TO,
			"--note",
			msg,
			"--as",
			SUP,
			"--scope",
			PARENT,
		);
		if (r.code === 0) {
			journal.escalated[kind] = msg;
			saveJournal();
		}
	};

	// W146 interfaces-down: child briefs carry knowledge-interface guidance;
	// the aids: stanza is the preseeding placeholder (buckle W142 plugs in).
	const AIDS = [
		`context: before non-trivial code/doc work, query fleet knowledge (read_knowledge MCP when available; otherwise bun ${BIN}/coord.ts knowledge) for architecture, conventions, prior decisions, gotchas.`,
		`capture: bank durable, non-obvious learnings with bun ${BIN}/coord.ts knowledge-enqueue (facts derivable from a single file become pointers or are rejected at ingest).`,
		`aids: (preseeding placeholder — buckle W142 plugs provider aids in here)`,
	];

	// W576.1: the supervisor's launch path rides the SAME governed launch
	// authority as dispatch-next and fleet-loop dispatch — the W572 fencing:
	// per-sid launch lease → durable pre-exec intent (nonce + claim-revision
	// fence) → shared attempt budget → fenced executor (registration precedes
	// the harness) → registration receipt + early-exit veto → CAS failure
	// cleanup. A stale supervisor cannot release a moved claim; the shared
	// budget quarantines a poison item into NEED_DECISION.
	const dispatchChild = async (
		item: string,
		lanes: Lane[],
		resume?: Lane,
	): Promise<string | null> => {
		// scope isolation: read the parent chain BEFORE any dispatch action
		if (!inScope(db, PROJECT, PARENT, item)) {
			console.log(`SCOPE-REFUSED ${item} — not under ${PARENT}`);
			return null;
		}
		const sid = resume?.sid ?? sidOf(item);
		const wt = `${REPO}/.worktrees/${item}`;
		if (DRY) {
			// read-only: no claim, no worktree, no brief file, no spawn
			console.log(`DRY dispatch ${item} → ${sid}`);
			return `${item}→${sid}(dry)`;
		}
		const bin = resolveLaneExecutor("claude");
		if (!bin) {
			console.log(
				"SKIP — claude binary not found or configured executor unavailable",
			);
			return null;
		}
		const store = openStore();
		const nonce = crypto.randomUUID();
		let launchedProc: ReturnType<typeof spawnClaude> | undefined;
		let intent: LaunchIntent | undefined;
		let claimRevision: number | undefined;
		let committed = false;
		if (!acquireLaunchLease(store, PROJECT, sid, nonce)) {
			console.log(`SKIP ${item} — another dispatcher owns the launch lease`);
			return null;
		}
		try {
			// W572 fence: a durable intent that is not PROVEN dead — registered
			// pid+birth observed absent — blocks the re-launch; unknown holds.
			const prior = launchIntent(store, PROJECT, item);
			if (prior && inspectLaunchIntent(prior) !== "dead")
				throw new Error("durable launch intent alive or uncertain");
			const limit = laneAttemptLimit(process.env.SUSPENDERS_LANE_MAX_ATTEMPTS);
			const attempt = nextReservedAttempt(store, PROJECT, item, 0, sid);
			if (attempt >= limit)
				throw new Error(
					"item launch budget exhausted; operator review required",
				);
			const take = cli(
				"work.ts",
				"take",
				item,
				"--as",
				sid,
				"--origin",
				`${hostname()}:claude`,
			);
			if (take.code !== 0) {
				// structured ownership only — no display-text includes() reads
				const mine = cli("work.ts", "show", item, "--json");
				if (!isResumableClaim(mine.out, item, sid)) {
					console.log(
						`SKIP ${item} — claimed elsewhere: ${take.out.split("\n")[0]}`,
					);
					return null;
				}
				// claimed by this sid from a previous dispatch attempt — resume
			}
			// W643: capture the take-minted claim token (env pin + context bank
			// below; a resume has none here — the context keeps the original).
			const takeToken =
				take.code === 0
					? (/claim token: ([0-9a-f]{48})/.exec(take.out)?.[1] ?? null)
					: null;
			parentToken = takeToken ?? parentToken;
			const claimedRow = store
				.query(
					"SELECT updated_at FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(PROJECT, item, sid) as { updated_at: number } | null;
			if (!claimedRow)
				throw new Error("claim changed before launch preparation");
			claimRevision = claimedRow.updated_at;
			intent = reserveLaunchIntent(
				store,
				{
					project: PROJECT,
					item,
					sid,
					nonce,
					revision: claimRevision,
					executor: bin,
				},
				limit,
				attempt - 1,
			);
			if (!existsSync(wt)) {
				const created = cli("worktree.ts", "create", item);
				if (created.code !== 0) {
					console.log(
						`SKIP ${item} — worktree create failed: ${created.out.split("\n")[0]}`,
					);
					return null;
				}
			}
			const branch =
				sh(["git", "-C", wt, "branch", "--show-current"]) ||
				`suspenders/${item}`;
			// completion law (W573): the immutable baseline evidence rides the
			// launch — work done refuses a dispatched lane without its context
			const contextFile = `${wt}/.fleet/lane-context.json`;
			mkdirSync(`${wt}/.fleet`, { recursive: true });
			if (takeToken) {
				// W643: merge the fresh take token into the context (create-with-
				// baseline when absent; token-only merge when it exists).
				const prior = existsSync(contextFile)
					? (JSON.parse(readFileSync(contextFile, "utf8")) as Record<
							string,
							unknown
						>)
					: null;
				writeFileSync(
					contextFile,
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
			} else if (!existsSync(contextFile))
				writeFileSync(
					contextFile,
					JSON.stringify({
						sid,
						item,
						baseline: sh(["git", "-C", wt, "rev-parse", "HEAD"]),
						launchedAt: Date.now(),
					}),
				);
			const show = cli("work.ts", "show", item);
			const capsule = parseCapsuleGet(
				cli("coord.ts", "capsule", "get", "--as", sid).out,
			);
			const brief = composeBrief({
				item,
				showOut: show.out,
				sid,
				branch,
				worktree: wt,
				capsule,
				itemCapsule: itemCapsuleGet(item),
				repo: REPO,
				aids: AIDS,
				extra: [
					...preferRoutingBriefLines(resolveRoutingPrefer(REPO)),
					`SUPERVISION: this lane runs under micro-supervisor ${SUP} (subtree of ${PARENT}). It reads the graph + your capsule every cycle; you are reachable via coord inbox --as ${sid}.`,
					`On a conflict or ambiguity you cannot resolve: bun ${BIN}/coord.ts emit NEED_DECISION --to ${SUP} --note "..." --as ${sid} — never silently wait.`,
				],
			});
			const briefFile = `${FLEET}/brief-${sid}.md`;
			mkdirSync(FLEET, { recursive: true });
			writeFileSync(briefFile, brief);
			const env = laneEnv(
				{
					...process.env,
					...(takeToken ? { KLH_CLAIM_TOKEN: takeToken } : {}),
				},
				false,
			);
			env.SUSPENDERS_SID = sid;
			if (
				!store
					.query(
						"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
					)
					.get(PROJECT, item, sid, claimRevision)
			)
				throw new Error("claim changed before executor spawn");
			if (!renewLaunchLease(store, PROJECT, sid, nonce))
				throw new Error("launch lease replaced before spawn");
			const laneLog = `${FLEET}/lane-${sid}.log`;
			const proc = spawnClaude({
				bin: fencedExecutor(FLEET, intent),
				prompt: `Read ${briefFile} and execute it fully.`,
				cwd: wt,
				logFile: laneLog,
				env,
				fleetDir: FLEET,
				sid,
			});
			launchedProc = proc;
			await awaitLaunchRegistration(store, FLEET, intent, proc);
			// only rejects immediate startup failure; not a health proof
			const earlyExit = await Promise.race([
				proc.exited,
				Bun.sleep(1000).then(() => null),
			]);
			if (earlyExit !== null)
				throw new Error(
					`executor exited during launch (code ${earlyExit}); inspect ${laneLog}`,
				);
			proc.unref();
			lanes.push({
				sid,
				item,
				pid: proc.pid,
				branch,
				worktree: wt,
				agent: "claude",
				host: hostname(),
				slab: laneClassOf("claude"),
				launchedAt: Date.now(),
				attempt: intent.attempt,
			});
			if (!renewLaunchLease(store, PROJECT, sid, nonce))
				throw new Error("launch lease replaced before registry persistence");
			assertLaunchClaim(store, intent, true);
			committed = true;
			console.log(
				`dispatched ${item} → ${sid} (pid ${proc.pid})${resume ? " — resumed from capsule" : ""}`,
			);
			return `${item}→${sid}(pid ${proc.pid})`;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// the shared budget quarantines poison items loudly — the decision
			// belongs to the coordinator, not to a per-entrypoint retry counter
			if (msg.includes("budget exhausted"))
				escalate(
					`launch-budget-${item}`,
					`launch budget for ${item} exhausted — ${msg}`,
				);
			console.log(`REFUSED ${item} — launch failed: ${msg}`);
			return null;
		} finally {
			if (!committed) {
				let stopped = true;
				try {
					if (launchedProc) await terminateOwnLaunch(launchedProc);
				} catch (error) {
					stopped = false;
					console.log(
						`LAUNCH-CLEANUP ${item} — own child termination failed: ${String(error)}`,
					);
				}
				if (stopped && intent) {
					try {
						finishFailedLaunch(store, intent);
					} catch (error) {
						console.log(
							`LAUNCH-CLEANUP ${item} — intent update failed: ${String(error)}`,
						);
					}
				}
				if (stopped && claimRevision !== undefined) {
					try {
						const released = releaseFailedLaunch(store, {
							project: PROJECT,
							item,
							sid,
							revision: claimRevision,
							nonce,
						});
						console.log(
							`LAUNCH-CLEANUP ${item} — ${released ? "claim released" : "claim changed; preserved"}`,
						);
					} catch (error) {
						console.log(
							`LAUNCH-CLEANUP ${item} — configured store release failed: ${String(error)}`,
						);
					}
				}
			}
			releaseLaunchLease(store, PROJECT, sid, nonce);
			store.close();
		}
	};

	const finish = (how: string): { closed: boolean } => {
		fact(
			`supervise.${pl}.closed`,
			`${PARENT} closed (${how}) — subtree terminal + integrated, evidence @${headSha().slice(0, 8)}`,
		);
		bankCapsule(`subtree closed: ${how}`, "none — supervisor exiting");
		console.log(`CLOSED ${PARENT} — ${how}`);
		return { closed: true };
	};

	const cycle = async (): Promise<{ closed: boolean }> => {
		const parent = getItem(PARENT);
		if (!parent) die(`item ${PARENT} vanished from the graph`);
		const kids = descendants(PARENT);
		console.log(
			`── ${new Date().toISOString()} parent ${PARENT} (${parent.state}) descendants: ${kids.length}${DRY ? " [DRY]" : ""}`,
		);
		// ── shatter: only with caller-supplied titles; never invent the plan
		if (kids.length === 0) {
			if (TITLES.length === 0) {
				escalate(
					"no-children",
					`${PARENT} has no children and no titles were given — the decomposition is a held decision, not mine to invent`,
				);
				return { closed: false };
			}
			console.log(`shattering ${PARENT} → ${TITLES.length} children`);
			if (DRY) {
				for (const t of TITLES) console.log(`  would split child: ${t}`);
				return { closed: false };
			}
			const args = [
				"split",
				PARENT,
				...TITLES,
				"--reason",
				`supervised by ${SUP}`,
			];
			if (PLAN) args.push("--plan", PLAN);
			const r = cli("work.ts", ...args);
			if (r.code !== 0) {
				escalate(
					"split-refused",
					`work split refused: ${r.out.split("\n")[0]}`,
				);
				return { closed: false };
			}
		}
		// ── dispatch(ready children): `work ready` already encodes dep order +
		// the W60 merge gate; the supervisor only narrows it to its subtree.
		// the supervisor's own parent item is never a lane — a READY parent
		// means shatter-or-escalate, not dispatch (and it must not burn the
		// parent item's own launch budget, W576.1)
		const ready = parseReady(cli("work.ts", "ready").out).filter(
			(r) =>
				r.id !== PARENT &&
				!isOwnerGated(r.title) &&
				inScope(db, PROJECT, PARENT, r.id),
		);
		const lanes = loadLanes(FLEET);
		// W576.1: one liveness verdict for the whole loop — the shared tri-state
		// (process identity + claimant transcript, W494.1/W610) plus the durable
		// launch intents: an intent that is not proven dead occupies capacity
		// (W572 fence). The worktree cwd is an alive-rescue, never a death signal.
		const held = DRY ? new Set<string>() : heldLaunchItems(db, PROJECT);
		const live = lanes.filter((l) => laneAlive(l) || worktreeLive(l.worktree));
		const liveItems = new Set(live.map((l) => l.item));
		const heldSlots = [...held].filter((it) => !liveItems.has(it)).length;
		// ── resume dead in-scope lanes FIRST (same sid, capsule carries over)
		let dispatched = 0;
		const notes: string[] = [];
		// snapshot: dispatchChild pushes into lanes[] — iterating the live array
		// would re-qualify the just-pushed (already-dead) entries in-loop
		for (const l of [...lanes]) {
			if (live.includes(l) || liveItems.has(l.item)) continue;
			if (!inScope(db, PROJECT, PARENT, l.item)) continue;
			const st = getItem(l.item);
			if (
				!st ||
				(st.state !== "CLAIMED" && st.state !== "RUNNING") ||
				st.owner_sid !== l.sid
			)
				continue;
			// W572 fence: resume only a PROVEN-dead durable intent — the intent
			// replaces the per-entrypoint grace window and retry counter
			const prior = launchIntent(db, PROJECT, l.item);
			if (prior && inspectLaunchIntent(prior) !== "dead") continue;
			if (worktreeLive(l.worktree)) continue; // alive-veto, not death evidence
			if (DRY) {
				notes.push(`would resume ${l.item} (lane ${l.sid} dead, item CLAIMED)`);
				continue;
			}
			const out = await dispatchChild(l.item, lanes, l);
			if (out) {
				dispatched++;
				notes.push(out);
			}
		}
		// ── dispatch fresh READY children up to target concurrency
		for (const r of ready) {
			if (liveItems.size + heldSlots + dispatched >= TARGET) break;
			if (liveItems.has(r.id)) continue;
			const out = await dispatchChild(r.id, lanes);
			if (out) {
				dispatched++;
				notes.push(out);
			}
		}
		if (dispatched > 0 && !DRY) {
			// persist the registry so a restarted supervisor finds resume candidates
			saveLanes(lanes, FLEET);
			fact(
				`supervise.${pl}.dispatched`,
				`${dispatched} lane(s) this cycle: ${notes.join(", ")}`,
			);
			bankCapsule(
				`dispatched: ${notes.join(", ")}`,
				`watching ${kids.length} descendants`,
			);
		}
		// ── unblock/integrate: DONE children must satisfy the repo's dep-merge
		// contract (result_sha ancestor of main) before the subtree can close
		for (const k of kids) {
			if (k.state !== "DONE" || !k.result_sha) continue;
			if (shaOnMain(k.result_sha) === true) {
				try {
					flagIntegratedCode({
						repo: REPO,
						before: `${k.result_sha}^`,
						after: "main",
						changedThrough: k.result_sha,
						source: SUP,
						dryRun: DRY,
					});
				} catch (error) {
					escalate(
						`decomposition-${k.id}`,
						`Merged-code decomposition check failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			if (shaOnMain(k.result_sha) !== false) continue;
			const br = `suspenders/${k.id}`;
			if (INTEGRATE === "merge") {
				if (DRY) {
					console.log(`would merge ${br} into main (${k.id} DONE, unmerged)`);
					continue;
				}
				console.log(`integrating ${k.id} — merging ${br}`);
				const beforeMerge = headSha();
				const m = run([
					"git",
					"-C",
					REPO,
					"merge",
					"--no-ff",
					br,
					"-m",
					`integrate ${k.id} (supervised by ${SUP})`,
				]);
				if (m.code !== 0) {
					run(["git", "-C", REPO, "merge", "--abort"]);
					escalate(
						`merge-${k.id}`,
						`merge of ${br} failed (conflict) — needs a decision`,
					);
				} else {
					try {
						flagIntegratedCode({
							repo: REPO,
							before: beforeMerge,
							after: headSha(),
							source: SUP,
						});
					} catch (error) {
						escalate(
							`decomposition-${k.id}`,
							`Merged-code decomposition check failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					fact(
						`supervise.${pl}.integrated`,
						`${k.id} merged (${br}) into main @${headSha().slice(0, 8)}`,
					);
				}
			} else {
				escalate(
					`unmerged-${k.id}`,
					`${k.id} DONE but ${k.result_sha.slice(0, 8)} is not on main — verify mode refuses to close; merge ${br} or run with --integrate=merge`,
				);
			}
		}
		// ── FAILED children hold the whole subtree — surface, never wait
		for (const k of kids) {
			if (k.state !== "FAILED") continue;
			escalate(
				`failed-${k.id}`,
				`${k.id} FAILED — subtree needs a decision (retry, supersede, or re-plan)`,
			);
		}
		// ── watch: drain the inbox (cursor never advanced — board/coordinator
		// messages surface here every cycle)
		if (!DRY) {
			const inbox = cli("coord.ts", "inbox", "--as", SUP);
			if (inbox.out) console.log(`inbox:\n${inbox.out}`);
		}
		// ── close: everything terminal + integrated → record evidence
		const terminal = (k: Item): boolean =>
			k.state === "DONE" || k.state === "SUPERSEDED";
		const allTerminal = kids.length > 0 && kids.every(terminal);
		const allMerged = kids.every(
			(k) =>
				k.state !== "DONE" ||
				!k.result_sha ||
				shaOnMain(k.result_sha) !== false,
		);
		if (allTerminal && allMerged) {
			const cur = getItem(PARENT);
			if (cur?.state === "DONE")
				return finish("parent already DONE via graph roll-up");
			if (
				cur &&
				(cur.state === "CLAIMED" || cur.state === "RUNNING") &&
				cur.owner_sid === SUP
			) {
				const r = cli(
					"work.ts",
					"done",
					PARENT,
					"--sha",
					headSha(),
					"--as",
					SUP,
					...(parentToken ? (["--token", parentToken] as const) : []),
				);
				if (r.code === 0)
					return finish("parent marked DONE with integration evidence");
				escalate(
					"close-refused",
					`work done ${PARENT} refused: ${r.out.split("\n")[0]}`,
				);
			}
		}
		return { closed: false };
	};

	for (;;) {
		let st: { closed: boolean };
		try {
			st = await cycle();
		} catch (e) {
			console.error(
				`cycle error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
			);
			if (ONCE) process.exit(1);
			await Bun.sleep(POLL);
			continue;
		}
		if (ONCE || st.closed) break;
		await Bun.sleep(POLL);
	}
	saveJournal();
	console.log("supervisor exit");
};

if (import.meta.main) await main();
