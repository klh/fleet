#!/usr/bin/env bun
// dispatch-next.ts — suspenders refills its own fleet (W145, "eat own dog
// food"). The POLICY half of the dispatch loop: pick READY unblocked items
// from the Work Graph, brief a headless lane, spawn it daemonized. The
// plumbing conventions (worktree, lanes.json, DISPATCHED log line, env
// scrub) mirror `hooks/bin/fleet-loop.ts dispatch` so the loop's pid guard,
// retire lifecycle, and `lanes` verb cover the lanes we spawn; the brief
// adds what the fleet needs to be self-resuming:
//
//   - capsule protocol  — lanes bank a ≤10-line continuation capsule at every
//     work-unit boundary (`coord capsule set/get`, hooks/bin/coord.ts); the
//     LAST capsule stands as the hand-off.
//   - landing chain     — commit → work done --sha → coord fact set finding.
//   - resume path       — alive lane: reachable via its sid on the graph
//     (owner_sid + coord inbox). Dead lane: re-dispatch reuses the sid,
//     reads the capsule + item state, and returns them as RESUME CONTEXT.
//
//   bun scripts/dispatch-next.ts [--repo <dir>] [--target N] [--dry-run]
//                                [--item Wn] [--no-belt]
//                                [--allow-ungoverned] [--show-capsule <sid>]
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { hostname } from "node:os";
import {
	applyLaneAttribution,
	DEFAULT_ALLOWED_TOOLS,
	laneEnv,
	probeBuckleFront,
	spawnClaude,
} from "./lib/lane.ts";
import { applyInsertion, insertionCtx } from "./lib/insertion.ts";
import {
	ensureLaneKey,
	adminKey,
	revokeLaneKey,
	laneKeyMetaPath,
	LANE_KEY_TTL_S,
	type MintedLaneKey,
} from "./lib/lane-auth.ts";
import { briefVerdictLine, verifyBrief } from "./lib/brief-verify.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
import {
	canonicalProjectRoot,
	loadLaneRegistry,
	mergeLaneRegistry,
} from "../hooks/lib/lane-registry.ts";
import { flushLaneUsageFacts, meterCopilotLanes } from "./lib/copilot-meter.ts";
import { condensePrompt } from "../hooks/board/prompt-transform.ts";
import { readBoardSettings } from "../hooks/lib/board-config.ts";
import { resolveHub } from "../hooks/lib/hub-locate.ts";
import {
	resolveLaneExecutor,
	releaseFailedLaunch,
	acquireLaunchLease,
	renewLaunchLease,
	releaseLaunchLease,
} from "./lib/launch-preflight.ts";
import { isResumableClaim } from "./lib/resumable-claim.ts";
import { laneAttemptLimit, nextLaneAttempt } from "./lib/lane-retry-budget.ts";
import { recoverableClaims } from "./lib/claim-recovery.ts";
// W494.1: the worktree-cwd probe is the shared EVIDENCE helper now — the
// verdict itself lives in hooks/lib/lane-liveness.ts (pid/heartbeat, never cwd)
import {
	laneProcessIdentity,
	worktreeLive,
} from "../hooks/lib/lane-liveness.ts";

const argv = process.argv.slice(2);
// Command discovery must precede repo lookup, claims, registry writes and spawn.
if (import.meta.main && (argv.includes("--help") || argv.includes("-h"))) {
	console.log(`Usage: dispatch [options]

Refill agent lanes from READY work and resume unfinished claims.

  --repo <dir>             Project checkout (default: Git root)
  --target <N>             Desired live lane count (default: 6)
  --dry-run                Preview without launching or changing claims
  --item <Wn>              Dispatch one specific work item
  --no-belt                Skip belt executor selection
  --allow-ungoverned       Explicitly allow a surfaced governance bypass
  --show-capsule <sid>      Print a lane's saved continuation capsule
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
// Governance target (owner directive 2026-10-05: everything under buckle +
// suspenders — lanes are the governed path, so the default fleet width rises
// from 3 to 8; --target still overrides per invocation).
// W500 OOM: 8 concurrent lanes × local-model KV growth helped kill the
// machine (python fleet 91GB of 128GB, jetsam 2026-10-06 22:14). The
// fanout-rate-budget lesson's cap is 6 — default follows it.
const TARGET = Number(val("--target") ?? 6);
// W494: REPO is the repo ROOT, never cwd — the loop runs from
// packages/<name> in the monorepo, and worktrees/briefs live at
// <root>/.worktrees (worktree.ts derives toplevel from the project
// identity). cwd-as-root ENOENT'd the brief write mid-dispatch and
// stranded half-born claims. (sh/run live further down — inline the
// spawn here, const bindings don't hoist.)
const gitToplevel = (): string => {
	const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	return out || process.cwd();
};
const CALLER_REPO = resolve(val("--repo") ?? gitToplevel());
const REPO = canonicalProjectRoot(CALLER_REPO);
const DRY = argv.includes("--dry-run");
// explicit single-item dispatch (W145 docstring promised this, never wired
// up): bypasses the FIFO ready-pool pick so a caller with its own priority
// analysis (collision-checked picks, owner direction) can target one item
// precisely instead of whatever sorts first in `work ready`.
const ITEM = val("--item");
const NO_BELT = argv.includes("--no-belt");
// W463 fail-closed governance: belt-direct is never a silent fallback. When
// the buckle front answers but the lane key can't be minted, dispatch REFUSES
// unless the operator passed this flag (loud, logged, disclosed in the brief).
const ALLOW_UNGOVERNED = argv.includes("--allow-ungoverned");
const SHOW_CAPSULE = val("--show-capsule");
const BIN = `${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin`;
const FLEET = `${REPO}/.fleet`;
const LOOP_LOG = `${FLEET}/loop.log`;
// W463: mint failures refuse the dispatch (fail-closed). Collected so main()
// exits non-zero — a refused lane must not read as a healthy no-op dispatch.
const governanceRefusals: string[] = [];

/** Repo dotfile (.prefer, dotfiles-win law): `must=executor` / `prefer=`
 * / `hub=Label` / `hub-url=url[,url...]` — a repo pins its executor and
 * hub label. `hub` is resolved to a real endpoint by hub-locate.ts (owner
 * directive 2026-10-03: "local hub to remote hubs scenario" — label is not
 * just a display prefix); `hub-url` adds repo-declared one-off candidates
 * tried before the global registry (most specific intent wins, same rule
 * as must). Policy still gates: an executor the W201 allow-list denies
 * SKIPs with a loud note.
 *
 * `must=`/`prefer=` may repeat — owner directive 2026-10-03: "we don't care
 * if it's claude cli or copilot or anything like that, we just want the
 * agents working to always go for the MUST or try the PREFER (there can be
 * multiple must and prefer in sequential order)". All `must=` lines (file
 * order) come first in the chain, then all `prefer=` lines (file order) —
 * must always outranks prefer, ties broken by position. `chain` is that
 * full ordered list; execPick() walks it by attempt index. */
const preferOf = (): {
	chain: string[];
	hub: string | null;
	hubUrls: string[];
} => {
	try {
		const musts: string[] = [];
		const prefers: string[] = [];
		let hub: string | null = null;
		let hubUrlRaw = "";
		for (const line of readFileSync(`${CALLER_REPO}/.prefer`, "utf8").split(
			"\n",
		)) {
			const i = line.indexOf("=");
			if (i <= 0) continue;
			const k = line.slice(0, i).trim();
			const v = line.slice(i + 1).trim();
			if (!v) continue;
			if (k === "must") musts.push(v);
			else if (k === "prefer") prefers.push(v);
			else if (k === "hub") hub = v;
			else if (k === "hub-url") hubUrlRaw = v;
		}
		return {
			chain: [...musts, ...prefers],
			hub,
			hubUrls: hubUrlRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		};
	} catch {
		return { chain: [], hub: null, hubUrls: [] };
	}
};

const binOf = (e: string): string => (e === "copilot" ? "copilot" : "claude");
const modelOf = (e: string): string | null =>
	e === "claude" || e === "copilot" ? null : e;

/** Executor pick (W201 policy + W176 prefer-drives + dotfiles-win): a repo
 * .prefer MUST beats everything except the policy allow-list; otherwise the
 * first default_executors entry that survives wins. Non-claude/codex
 * executors ride the claude CLI with ANTHROPIC_MODEL pinned — belt routes
 * by model id, so a model name IS an executor. copilot rides its own CLI.
 * The hub label now resolves to a real endpoint via hub-locate.ts (hub,
 * hubUrls passed through for the caller to resolve — resolution is async,
 * network-touching, and does not belong in this sync picker).
 *
 * `attempt` walks the must/prefer chain (owner directive 2026-10-03:
 * sequential try-in-order, CLI-agnostic). Attempt 0 is the first `must=`
 * (or first `prefer=` when there's no must); a dead/resumed lane advances
 * the index so the fleet loop itself IS the cross-bin retry (claude ->
 * copilot works, not just model->model). Within one spawn, same-bin chain
 * entries AFTER the picked index ride natively too: claude's own
 * `--fallback-model` (comma list, retries in order, confirmed 2026-10-03
 * to recover even from a flat invalid-model-name 400 — not just overload)
 * — so a single process already tries several models before a re-dispatch
 * cycle is ever needed. */
const execPick = (
	attempt = 0,
): {
	agent: string;
	model: string | null;
	bin: string;
	hub: string | null;
	hubUrls: string[];
	fallbackModels: string[];
	chainLen: number;
	chainIdx: number;
} => {
	const prefer = preferOf();
	const s = readBoardSettings().settings;
	const enabled = s.enabled_executors;
	const allowed = (name: string): boolean => !enabled || enabled.includes(name);
	const label = (executor: string): string =>
		prefer.hub ? `[${prefer.hub.toUpperCase()}] ${executor}` : executor;
	if (prefer.chain.length > 0) {
		const idx = Math.min(attempt, prefer.chain.length - 1);
		const e = prefer.chain[idx];
		// W228 owner law: must ALWAYS wins — a repo .prefer is the more
		// specific owner intent; allow-list collision is surfaced, never
		// silently rerouted.
		if (!allowed(e))
			console.log(
				`NOTE — .prefer chain[${idx}]=${e} not in enabled_executors; MUST WINS (W228)`,
			);
		const bin = binOf(e);
		// same-bin tail after idx: natively chained via --fallback-model so
		// one process tries all of them before a dead-lane re-dispatch is
		// needed; a bin switch further down the chain can only be reached
		// by that re-dispatch (a CLI flag can't cross binaries mid-process).
		const fallbackModels = prefer.chain
			.slice(idx + 1)
			.filter((next) => binOf(next) === bin)
			.map((next) => modelOf(next))
			.filter((m): m is string => !!m);
		return {
			agent: label(e),
			model: modelOf(e),
			bin,
			hub: prefer.hub,
			hubUrls: prefer.hubUrls,
			fallbackModels,
			chainLen: prefer.chain.length,
			chainIdx: idx,
		};
	}
	const order = [...(s.default_executors ?? []), "claude"];
	for (const name of order) {
		if (!allowed(name)) continue;
		return {
			agent: label(name),
			model: modelOf(name),
			hub: prefer.hub,
			hubUrls: prefer.hubUrls,
			bin: binOf(name),
			fallbackModels: [],
			chainLen: 0,
			chainIdx: 0,
		};
	}
	return {
		agent: "claude",
		model: null,
		bin: "claude",
		hub: prefer.hub,
		hubUrls: prefer.hubUrls,
		fallbackModels: [],
		chainLen: 0,
		chainIdx: 0,
	};
};

type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	host?: string;
	hub?: string;
	launchedAt: number;
	attempt?: number;
};

const sh = (cmd: string[], cwd = REPO): string => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};
const run = (cmd: string[], cwd = REPO): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};
// lane liveness is THE plane's verdict (2026-10-05): work lanes --json
// (hooks/lib/lane-liveness.ts) is the one source dispatch-next, fleet-loop
// and humans share — recycled pids and permanently-trusted host lanes both
// read dead now. Missing audit observations fall back to process identity;
// a failed identity probe conservatively retains the occupied slot.
const laneAudit = (): Map<string, boolean> => {
	try {
		const raw = sh([
			process.execPath,
			`${BIN}/work.ts`,
			"lanes",
			"--json",
			"--fleet",
			FLEET,
		]);
		return new Map(
			(JSON.parse(raw) as Array<{ sid: string; live: boolean }>).map((a) => [
				a.sid,
				a.live,
			]),
		);
	} catch {
		return new Map();
	}
};
const laneAlive = (l: Lane, audit: Map<string, boolean>): boolean =>
	audit.get(l.sid) === true || laneProcessIdentity(l) !== false;
const log = (msg: string): void => {
	mkdirSync(FLEET, { recursive: true });
	appendFileSync(LOOP_LOG, `${new Date().toISOString()} ${msg}\n`);
};
const loadLanes = (): Lane[] => loadLaneRegistry<Lane>(FLEET);
const saveLanes = (lanes: Lane[]): void => mergeLaneRegistry(FLEET, lanes);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** parse `work ready` rows (renderRow format, ANSI-stripped): glyph, id,
 *  truncated title. The title is for gating/log lines only — the brief must
 *  carry the FULL spec from `work show` (gaps W279 phantom-lane lesson).
 *  W494: the renderer pads the id field (width 7) — ids ≥7 chars emit NO
 *  separator space, so the id/title gap is zero-or-more and the title may
 *  be empty. The [\d.]+ class stops the id at the first non-id char. */
export const parseReady = (stdout: string): { id: string; title: string }[] =>
	stdout
		.replace(ANSI, "")
		.split("\n")
		.map((l) => /^\s*·\s+(W[\d.]+)\s*(.*)$/.exec(l.trimEnd()))
		.map((m) => (m ? { id: m[1], title: m[2].trim() } : null))
		.filter((x): x is { id: string; title: string } => !!x);

/** decision-gated items never ride the automagic — they surface to the owner. */
export const isOwnerGated = (title: string): boolean =>
	/OWNER-GATED|OWNER GATE|\bGATED\b|\bHELD\b|NEED_DECISION|\bDECISION\b|PAUSED/i.test(
		title,
	);

/** W463 fail-closed governance (pure — unit-testable): given the lane-key
 *  mint outcome and the operator override flag, what happens to the lane?
 *  Default is REFUSE: a mint failure means no scopes, no attribution, no
 *  budgets — governance must not silently vanish. Belt-direct survives only
 *  as the explicit, loud, audited --allow-ungoverned operator override. */
export type GovernanceDecision =
	| { mode: "governed"; key: string; keyId: string }
	| { mode: "ungoverned-override"; note: string }
	| { mode: "belt-direct"; note: string }
	| { mode: "refuse"; why: string };

export const laneKeyDecision = (
	minted: MintedLaneKey | null,
	allowUngoverned: boolean,
	govMode: "strict" | "solo" = "strict",
): GovernanceDecision => {
	if (minted) return { mode: "governed", key: minted.key, keyId: minted.keyId };
	if (allowUngoverned)
		return {
			mode: "ungoverned-override",
			note: "UNGOVERNED DISPATCH — operator override (--allow-ungoverned): buckle lane-key mint failed; lane rides belt direct with no buckle scopes, attribution or budgets",
		};
	return {
		mode: "refuse",
		// W422.17: solo relents only at the front probe, never at mint failures
		why:
			govMode === "solo"
				? "buckle lane-key mint failed — governance:solo does not relent at mint failures (fail-closed W463; --allow-ungoverned overrides)"
				: "buckle lane-key mint failed — check belt.env BUCKLE_ADMIN_KEY (fail-closed W463; --allow-ungoverned overrides)",
	};
};

/** W422.17 (owner ruling 2026-10-06): `coord fact get fleet.governance`
 *  output → "strict" | "solo". Absent/unknown → strict (fail-closed
 *  default). Pure — unit-testable. */
export const parseGovernanceMode = (factOut: string): "strict" | "solo" => {
	const first = (factOut.split("\n")[0] ?? "").trim();
	if (first === "(unset)") return "strict";
	return first.replace(/\s*\(v\d+\)$/, "").trim() === "solo"
		? "solo"
		: "strict";
};

/** W422.17 probe-false decision (pure — unit-testable): the buckle front did
 *  not answer the probe. --allow-ungoverned overrides BOTH modes; solo keeps
 *  the belt-direct fallback (loud, disclosed); strict refuses the lane with
 *  the same machinery as a W463 mint failure. */
export const probeFrontDecision = (
	allowUngoverned: boolean,
	govMode: "strict" | "solo",
): GovernanceDecision => {
	if (allowUngoverned)
		return {
			mode: "ungoverned-override",
			note: "UNGOVERNED DISPATCH — operator override (--allow-ungoverned): buckle front unreachable; lane rides belt direct with no buckle scopes, attribution or budgets",
		};
	if (govMode === "solo")
		return {
			mode: "belt-direct",
			note: "BELT-DIRECT DISPATCH — buckle front unreachable (governance:solo): lane rides belt direct with no buckle scopes, attribution or budgets",
		};
	return {
		mode: "refuse",
		why: "buckle front unreachable + governance:strict — lanes dispatch only through the buckle front (W422.17; --allow-ungoverned overrides per-invocation, coord governance solo relents)",
	};
};

// governance mode: read ONCE per dispatch run, through the coord CLI the
// script already uses for facts (copilot-meter pattern) — no second store,
// no raw sqlite on governor.db. Absent/broken fact reads fold to strict.
let governanceModeCache: "strict" | "solo" | null = null;
const governanceMode = (): "strict" | "solo" => {
	if (governanceModeCache) return governanceModeCache;
	governanceModeCache = parseGovernanceMode(
		run([
			process.execPath,
			`${BIN}/coord.ts`,
			"fact",
			"get",
			"fleet.governance",
		]).out,
	);
	return governanceModeCache;
};

/** `coord capsule get --as <sid>` output → parsed capsule, or null when the
 *  lane has none. (Bare `capsule get <sid>` misparses the sid as "get" —
 *  always pass --as.) */
export const parseCapsuleGet = (
	stdout: string,
): Record<string, string> | null => {
	const line = stdout.replace(ANSI, "").trim();
	if (!line || line.includes("(no capsule)")) return null;
	try {
		const c = JSON.parse(line) as Record<string, string>;
		return typeof c === "object" && c !== null ? c : null;
	} catch {
		return null;
	}
};

const capsuleGet = (sid: string): Record<string, string> | null =>
	parseCapsuleGet(
		sh([process.execPath, `${BIN}/coord.ts`, "capsule", "get", "--as", sid]),
	);

/** the mission brief. Everything a headless lane needs: full item spec,
 *  capsule protocol, landing chain, sid + how it gets resumed. Resume runs
 *  embed the dead lane's last capsule as RESUME CONTEXT. */
export const composeBrief = (o: {
	item: string;
	showOut: string;
	sid: string;
	branch: string;
	worktree: string;
	capsule: Record<string, string> | null;
	repo?: string;
	aids?: string[];
	extra?: string[];
	agent?: string;
	/** Archived-origin guard (the W428 lesson): set when the item's origin
	 *  is archived — the brief redirects the landing to the living repo. */
	landing?: string;
}): string => {
	const parts = [
		`You are lane "${o.sid}", Work Graph item ${o.item}, repo ${o.repo ?? REPO}. English only.`,
		``,
		`IDENTITY: executor ${o.agent ?? "claude"}. [HUB] prefixes are labels — traffic routes through that hub's gateway.`,
		``,
		`MISSION (from work show):`,
		// W334 caveman tier at the source: the lane's actual prompt text gets
		// the condense pass (filler/meta/dedupe, technical surface masked).
		condensePrompt(o.showOut.replace(ANSI, "").trim()),
		``,
		`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
		`FORMAT: Read the nearest .qlty/qlty.toml and Biome config, and match adjacent code. Use qlty fmt on changed files before final checks, tests and commit; never manually chase formatter wrapping. Successful auto-formatting is advisory: re-read only before editing that file again.`,
		`Inbox: before planning and again before finishing, check bun ${BIN}/coord.ts inbox --as ${o.sid} — coordinator and board messages arrive there.`,
		`COLLABORATION: after a second unchanged failure or an interface conflict, consult one relevant expert: bun ${BIN}/coord.ts consult --best "<command, error, attempts, precise question>" --scope "<package/path>" --as ${o.sid}. Inspect evidence before acting; avoid fleet-wide broadcasts. If no expert or no answer within 60 seconds, retain evidence in the capsule, continue independent work and request a decision before another unchanged attempt.`,
		`Reply with answer, evidence, applicability and next action. After trying an answer: bun ${BIN}/coord.ts consult-reply <Cnumber> --feedback resolved|failed|unused --evidence "<command and observed result>" --as ${o.sid}. Only verified answers at the same project, scope and code version are reused.`,
		`Work in the EXISTING worktree ${o.worktree} (branch ${o.branch}).`,
		``,
		`CAPSULE PROTOCOL — resumable lanes: at every work-unit boundary (a gate passed, a commit landed, before any pause) bank a ≤10-line capsule:`,
		`  bun ${BIN}/coord.ts capsule set --as ${o.sid} --checkpoint=<branch-head-sha|none> --file="<anchor path:line>" --done="<done so far>" --next="<next step>"`,
		`The LAST capsule stands as the hand-off: if this lane dies, the next dispatch resumes from it. A stale or missing capsule strands the work.`,
		``,
		`RESUME PATH: while your process is alive you are reachable via your sid — it is the item's owner_sid on the graph, and coord inbox --as ${o.sid} reaches you. If you die mid-item, the fleet loop re-dispatches the SAME sid, reads your latest capsule, and returns it below as RESUME CONTEXT. Reconcile with it and the worktree state — never restart blind.`,
		``,
		`LANDING CHAIN (all three, in order):`,
		`1. commit on ${o.branch} (subject starts with the item id) — land a checkpoint commit early; a zero-commit branch is indistinguishable from debris to the reaper.`,
		...(o.landing ? [o.landing] : []),
		`2. bun ${BIN}/work.ts done ${o.item} --sha <branch-head> --as ${o.sid}`,
		`3. bun ${BIN}/coord.ts fact set finding.${o.item.toLowerCase()} --text "<one-line headline + how to verify>" --source ${o.sid}`,
		``,
		`IDENTITY: prefix every progress note, inbox reply and your final report lines with [${o.item}] plus a locality tag when it aids scanning — [${o.item}·local], [${o.item}·remote], [${o.item}·sim], [${o.item}·buckle] — the owner's agent list shows your live activity text, and the id is what ties it to the graph. Humans deep-link your item on the fleet board as #task=${o.item}${process.env.FLEET_BOARD_URL ? ` (full URL: ${process.env.FLEET_BOARD_URL}/#task=${o.item})` : ""}; include the link in your final report.`,
		`CRAFT: ≤25-line anchored edits per write (content gate parse-checks; splice via /tmp chunks for larger); build verify every ~3rd edit; GUI deliverables get a headless-Chrome render-and-look pass against the LIVE surface with real data — report what you saw; evidence before claims, always.`,
		`VOICE (owner law 2026-10-03): terse — no preamble, no restating the task, no filler; minimal prose in commits, progress notes, questions and .klh-done.md. Tokens spent on prose are tokens not spent on work.`,
		``,
		`Final: DONE <sha> | SPLIT ${o.item} | BLOCKED (after 3 honest attempts, tree restored).`,
	];
	// W146 interfaces: down = knowledge interfaces + aids placeholder for the
	// child lane; extra = supervisor context lines appended verbatim.
	if (o.aids?.length) {
		parts.push(
			``,
			`AIDS (knowledge interfaces):`,
			...o.aids.map((a) => `  - ${a}`),
		);
	}
	if (o.extra?.length) parts.push(``, ...o.extra);
	if (o.capsule) {
		parts.push(
			``,
			`RESUME CONTEXT — latest capsule from a previous run of this lane (reconcile with the worktree + item state before continuing):`,
			JSON.stringify(o.capsule),
		);
	}
	return parts.join("\n");
};

// W460: sidOf is the legacy-named alias of the canonical laneSid —
// dispatch/supervise/fleet-loop/board must never derive sids independently
export const sidOf = laneSid;

/** one item → claim, worktree, brief, daemonized lane. Returns the summary
 *  fragment or null when the item cannot be taken (claimed elsewhere). */
// ─── archived-origin landing guard (the W428 lesson, 2026-10-05) ─────────
// The monorepo cutover archived every member origin — pushes to them
// bounce, and a lane that discovers this mid-run dies silently with its
// claim held (autow428). The brief carries the redirect BEFORE the lane
// pushes: probe the origin archive flag once per dispatch (10-min cache)
// and, when archived, redirect the landing to the living repo.
const ARCHIVE_PROBE_TTL_MS = 10 * 60_000;
const archiveProbeCache = new Map<string, { at: number; archived: boolean }>();
const GITHUB_SLUG = /github\.com[:/]+([^/]+)\/([^.]+?)(?:\.git)?$/;

export const landingRedirect = async (
	repo: string,
	branch: string,
): Promise<string | null> => {
	const note = (a: boolean): string | null =>
		a
			? `ORIGIN ARCHIVED (monorepo cutover): ${repo} is push-dead. Commit on ${branch} as usual, then push the branch to the living repo instead of the archived origin: git push https://github.com/klh/fleet.git HEAD:refs/heads/${branch} — work done --sha takes the FLEET head sha. Pushing to the archived origin bounces and ends the lane's run silently.`
			: null;
	return await probeArchive(repo, note);
};

const probeArchive = async (
	repo: string,
	note: (a: boolean) => string | null,
): Promise<string | null> => {
	const cached = archiveProbeCache.get(repo);
	if (cached && Date.now() - cached.at < ARCHIVE_PROBE_TTL_MS)
		return note(cached.archived);
	return await fetchArchiveFlag(repo, note);
};

const fetchArchiveFlag = async (
	repo: string,
	note: (a: boolean) => string | null,
): Promise<string | null> => {
	let archived = false;
	try {
		const r = run(["git", "-C", repo, "remote", "get-url", "origin"]);
		if (r.code === 0) {
			const m = GITHUB_SLUG.exec(r.out);
			if (m) {
				const res = await fetch(
					`https://api.github.com/repos/${m[1]}/${m[2]}`,
					{
						headers: { accept: "application/vnd.github+json" },
						signal: AbortSignal.timeout(8_000),
					},
				);
				if (res.ok)
					archived =
						((await res.json()) as { archived?: boolean }).archived === true;
			}
		}
	} catch {
		archived = false;
	}
	archiveProbeCache.set(repo, { at: Date.now(), archived });
	return note(archived);
};

const dispatchItem = async (
	item: string,
	lanes: Lane[],
	resume?: Lane,
): Promise<string | null> => {
	const sid = resume?.sid ?? sidOf(item, projectIdentity(REPO));
	let attempt = resume ? nextLaneAttempt(resume.attempt ?? 0) : 0;
	const limit = laneAttemptLimit(process.env.SUSPENDERS_LANE_MAX_ATTEMPTS);
	if (resume && attempt >= limit) {
		const note = `resume budget exhausted after ${limit} launches for ${item}; inspect lane ${sid}, its capsule and worktree before retrying`;
		console.log(`${DRY ? "DRY" : "STOP"} ${note}`);
		if (!DRY) {
			const failed = run([
				process.execPath,
				`${BIN}/work.ts`,
				"fail",
				item,
				"--as",
				sid,
				"--note",
				note,
			]);
			if (failed.code !== 0) throw new Error(failed.out);
			log(`lane.retry-exhausted ${item} ${sid}`);
			run([
				process.execPath,
				`${BIN}/coord.ts`,
				"emit",
				"NEED_DECISION",
				"--as",
				sid,
				"--scope",
				"suspenders",
				"--note",
				note,
			]);
		}
		return null;
	}
	const wt = `${REPO}/.worktrees/${item}`;
	if (DRY) {
		// read-only end to end: no claim, no worktree, no brief file, no spawn
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		const capsule = capsuleGet(sid);
		const branch = existsSync(wt)
			? sh(["git", "-C", wt, "branch", "--show-current"]) ||
				`suspenders/${item}`
			: `suspenders/${item}`;
		const pick = execPick(attempt);
		console.log(`DRY dispatch ${item} → ${sid}${capsule ? " (RESUME)" : ""}`);
		if (pick.chainLen > 1)
			console.log(
				`DRY chain attempt ${pick.chainIdx}/${pick.chainLen - 1} -> ${pick.agent}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
			);
		const brief = composeBrief({
			item,
			showOut: show.out,
			sid,
			branch,
			worktree: wt,
			capsule,
			agent: pick.agent,
			landing: await landingRedirect(REPO, branch),
		});
		console.log(brief);
		// W223.2: dry-run shows the verdict the spawn path would enforce
		const dryHarness: "claude" | "copilot" =
			pick.bin === "copilot" ? "copilot" : "claude";
		console.log(
			briefVerdictLine(
				verifyBrief(brief, { harness: dryHarness }),
				Buffer.byteLength(brief),
			),
		);
		return `${item}→${sid}(dry)`;
	}
	const store = openStore();
	const project = projectIdentity(REPO);
	const attemptKey = `lane.${sid}.launch-attempt`;
	const prior = store
		.query("SELECT value FROM facts WHERE key=?")
		.get(attemptKey) as { value: string } | null;
	if (prior && /^\d+$/.test(prior.value))
		attempt = Math.max(attempt, Number(prior.value) + 1);
	if (attempt >= limit) {
		governanceRefusals.push(item);
		const note = `launch budget exhausted after ${limit} attempts for ${item}; inspect ${sid} before resetting its launch-attempt fact`;
		console.log(`REFUSED ${item} — ${note}; nothing claimed or minted`);
		run([
			process.execPath,
			`${BIN}/coord.ts`,
			"emit",
			"NEED_DECISION",
			"--as",
			sid,
			"--scope",
			"suspenders",
			"--note",
			note,
		]);
		return null;
	}
	let pick = execPick(attempt);
	let bin = resolveLaneExecutor(pick.bin);
	if (!bin) {
		governanceRefusals.push(item);
		console.log(
			`REFUSED ${item} — executor unavailable: ${pick.bin}; set SUSPENDERS_${pick.bin.toUpperCase()}_BIN or install in ~/.local/bin; nothing claimed or minted`,
		);
		return null;
	}
	const nonce = crypto.randomUUID();
	if (!acquireLaunchLease(store, project, sid, nonce)) {
		console.log(
			`REFUSED ${item} — another dispatcher owns the launch lease; nothing claimed or minted`,
		);
		governanceRefusals.push(item);
		return null;
	}
	let claimRevision: number | undefined;
	let committedLaunch = false;
	let launchedProc: ReturnType<typeof spawnClaude> | undefined;
	let ownedKeyId: string | undefined;
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
		const latestAttempt = store
			.query("SELECT value FROM facts WHERE key=?")
			.get(attemptKey) as { value: string } | null;
		if (latestAttempt && /^\d+$/.test(latestAttempt.value))
			attempt = Math.max(attempt, Number(latestAttempt.value) + 1);
		if (attempt >= limit) {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — launch budget exhausted; nothing claimed or minted`,
			);
			return null;
		}
		pick = execPick(attempt);
		bin = resolveLaneExecutor(pick.bin);
		if (!bin) {
			governanceRefusals.push(item);
			console.log(
				`REFUSED ${item} — selected executor unavailable; nothing claimed or minted`,
			);
			return null;
		}
		const take = run([
			process.execPath,
			`${BIN}/work.ts`,
			"take",
			item,
			"--as",
			sid,
			"--origin",
			`${hostname()}:claude`,
		]);
		if (take.code !== 0) {
			const show = run([
				process.execPath,
				`${BIN}/work.ts`,
				"show",
				item,
				"--json",
			]);
			if (show.code !== 0 || !isResumableClaim(show.out, item, sid)) {
				console.log(
					`SKIP ${item} — claimed elsewhere: ${take.out.split("\n")[0]}`,
				);
				return null;
			}
			// claimed by this sid from a previous dispatch attempt — resume
		}
		const claimedRow = store
			.query(
				"SELECT updated_at FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
			)
			.get(project, item, sid) as { updated_at: number } | null;
		if (!claimedRow) throw new Error("claim changed before launch preparation");
		claimRevision = claimedRow.updated_at;
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
		}
		const branch =
			sh(["git", "-C", wt, "branch", "--show-current"]) || `suspenders/${item}`;
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		const capsule = capsuleGet(sid);
		// a resumed (dead, re-dispatched) lane advances the must/prefer chain —
		// attempt N having died is exactly the signal to try chain[N+1] next
		// (owner directive 2026-10-03: sequential must/prefer, CLI-agnostic).
		if (pick.chainLen > 1)
			console.log(
				`NOTE — .prefer chain attempt ${pick.chainIdx}/${pick.chainLen - 1}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
			);
		// W293 session-name bridge: stamp the lane's user-facing name onto the
		// sessions row (tags JSON) so coord fleet + the board show e.g.
		// "[IKEA] opus W5" instead of an opaque sid. Renames on resume (the chain
		// can switch executor between attempts). The lane's own session-start
		// upsert never touches the tags column, so the name survives registration.
		run([
			process.execPath,
			`${BIN}/coord.ts`,
			"bootstrap",
			"--as",
			sid,
			"--name",
			`${pick.agent} ${item}`,
		]);
		const brief = composeBrief({
			item,
			showOut: show.out,
			sid,
			branch,
			worktree: wt,
			capsule,
			agent: pick.agent,
		});
		// W223.2 dual-harness brief verification: copilot's prompt handling can
		// mangle a brief claude renders fine, so the copilot harness gets a hard
		// gate — a failing brief refuses the spawn AND reclaims the claim (a
		// stranded claim on a never-spawned lane is the exact disease quota-sweep
		// cures). claude runs the same checks warn-only (no observed claude
		// mangling; hard-gating claude is a separate behavior change).
		const harness: "claude" | "copilot" =
			pick.bin === "copilot" ? "copilot" : "claude";
		const verdict = verifyBrief(brief, { harness });
		if (!verdict.ok && harness === "copilot") {
			const why = briefVerdictLine(verdict, Buffer.byteLength(brief));

			console.log(
				`SKIP ${item} — brief refused by ${harness} verification: ${why} — launch refused; claim cleanup follows, nothing spawned`,
			);
			return null;
		}
		if (!verdict.ok)
			console.log(
				`NOTE — ${briefVerdictLine(verdict, Buffer.byteLength(brief))} (claude warn-only, dispatched anyway)`,
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
		const env = laneEnv({ ...process.env }, NO_BELT);
		env.SUSPENDERS_SID = sid;
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
		let resolvedHub: string | undefined;
		if (!NO_BELT) {
			// always pin a model — an unpinned lane inherits the owner's global
			// settings.json ANTHROPIC_DEFAULT_*_MODEL (glm-5.3[1m]) and dies on
			// client-side unrecognized_model before its first wire call
			const ctx = insertionCtx(env, pick.model ?? "glm-5.3-flash");
			if (pick.hub) {
				const hub = await resolveHub(pick.hub, pick.hubUrls);
				if (hub) {
					ctx.anthropicBase = hub.url;
					ctx.openaiBase = `${hub.url}/v1`;
					env.SUSPENDERS_HUB = hub.label;
					env.SUSPENDERS_HUB_VIA = hub.via;
					hubNote = ` — hub ${hub.label} -> ${hub.url} (${hub.via})`;
					resolvedHub = hub.label;
				} else {
					hubNote = ` — NOTE hub=${pick.hub} unreachable, falling back to local belt (W228-style: surfaced, never silent)`;
					console.log(
						`NOTE — .prefer hub=${pick.hub} unreachable; using local belt`,
					);
				}
			}
			applyInsertion(env, pick.bin, ctx);
			// W1 dispatch-side adoption (finding.w1): the lane rides the buckle
			// front with /w/<sid> so usage attributes per lane (route_audit.lane).
			// W463 fail-closed: the gate demands bksk_ keys, so a mint failure
			// REFUSES the lane — governance must not silently vanish — and only
			// the explicit --allow-ungoverned override rides belt direct. Skipped
			// entirely when a hub redirect won (the hub owns the base URL).
			// W422.17: probe once — front up rides the W463 governed mint path,
			// front down branches on the governance mode (strict refuses, solo
			// keeps the belt-direct fallback). undefined = hub won, skip entirely.
			const frontUp: string | null | undefined = resolvedHub
				? undefined
				: await probeBuckleFront();
			if (frontUp) {
				const decision = laneKeyDecision(
					await ensureLaneKey(sid),
					ALLOW_UNGOVERNED,
					governanceMode(),
				);
				if (decision.mode === "governed") {
					applyLaneAttribution(env, sid);
					env.ANTHROPIC_AUTH_TOKEN = decision.key;
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
		const laneLog = `${FLEET}/lane-${sid}.log`;
		// settings.json env CLOBBERS the process env at CLI startup (probed live
		// 2026-10-05: a lane pinned to glm-5.3-flash still resolved glm-5.3[1m]).
		// --settings outranks user settings: write the lane-critical vars and pass
		// the file on the CLI layer. 0600 — it carries the lane token.
		const laneSettings = `${FLEET}/lane-settings-${sid}.json`;
		const m = pick.model ?? "glm-5.3-flash";
		const settingsData = JSON.stringify(
			{
				env: {
					ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "opus",
					ANTHROPIC_DEFAULT_OPUS_MODEL: m,
					ANTHROPIC_DEFAULT_SONNET_MODEL:
						env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? m,
					ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? m,
					ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
					ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
				},
			},
			null,
			2,
		);
		writtenFiles.set(laneSettings, settingsData);
		writeFileSync(laneSettings, settingsData);
		chmodSync(laneSettings, 0o600);
		const settingsArgs = ["--settings", laneSettings];
		// Immutable evidence base survives resumes and later main-branch merges.
		const completionContext = `${wt}/.fleet/lane-context.json`;
		mkdirSync(`${wt}/.fleet`, { recursive: true });
		if (!existsSync(completionContext))
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
			bin,
			prompt,
			cwd: wt,
			logFile: laneLog,
			env,
			cliArgs:
				pick.bin === "copilot"
					? ["--allow-all-tools"]
					: pick.fallbackModels.length > 0
						? [
								"--allowedTools",
								DEFAULT_ALLOWED_TOOLS,
								"--permission-mode",
								"acceptEdits",
								"--fallback-model",
								pick.fallbackModels.join(","),
								...settingsArgs,
							]
						: [
								"--allowedTools",
								DEFAULT_ALLOWED_TOOLS,
								"--permission-mode",
								"acceptEdits",
								...settingsArgs,
							],
		});
		launchedProc = proc;
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
		const entry: Lane = {
			sid,
			item,
			pid: proc.pid,
			branch,
			worktree: wt,
			agent: pick.agent,
			host: hostname(),
			hub: resolvedHub,
			launchedAt: Date.now(),
			attempt,
		};
		// Accept the launch only after its PID and ownership are durable.
		if (!renewLaunchLease(store, project, sid, nonce))
			throw new Error("launch lease replaced before registry persistence");
		saveLanes([entry]);
		lanes.push(entry);
		committedLaunch = true;
		log(`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch})${hubNote}`);
		console.log(
			`dispatched ${item} → ${sid} (pid ${proc.pid})${capsule ? " — resumed from capsule" : ""}${hubNote}`,
		);
		return `${item}→${sid}(pid ${proc.pid})`;
	} catch (error) {
		governanceRefusals.push(item);
		console.log(`REFUSED ${item} — launch failed: ${String(error)}`);
		log(`REFUSED ${item} → ${sid} — launch failed: ${String(error)}`);
		return null;
	} finally {
		if (!committedLaunch) {
			let ownsFiles = false;
			try {
				ownsFiles = renewLaunchLease(store, project, sid, nonce);
			} catch (error) {
				log(`LAUNCH-CLEANUP ${item} — lease check failed: ${String(error)}`);
			}
			if (launchedProc && launchedProc.exitCode === null) {
				try {
					launchedProc.kill();
					await Promise.race([launchedProc.exited, Bun.sleep(1000)]);
				} catch (error) {
					log(
						`LAUNCH-CLEANUP ${item} — own child termination failed: ${String(error)}`,
					);
				}
			}
			if (claimRevision !== undefined) {
				try {
					const released = releaseFailedLaunch(store, {
						project,
						item,
						sid,
						revision: claimRevision,
						nonce,
					});
					log(
						`LAUNCH-CLEANUP ${item} — ${released ? "claim released" : "claim changed; preserved"}`,
					);
				} catch (error) {
					log(
						`LAUNCH-CLEANUP ${item} — configured store release failed: ${String(error)}`,
					);
				}
			}
			if (ownedKeyId) {
				try {
					const admin = adminKey();
					const revoked = admin
						? await revokeLaneKey(ownedKeyId, admin)
						: false;
					log(
						`LAUNCH-CLEANUP ${item} — own key ${ownedKeyId} ${revoked ? "revoked" : "revoke failed; TTL bounds it"}`,
					);
				} catch (error) {
					log(
						`LAUNCH-CLEANUP ${item} — own key revoke failed: ${String(error)}`,
					);
				}
			}
			for (const [path, expected] of ownsFiles ? writtenFiles : []) {
				try {
					if (readFileSync(path, "utf8") === expected) rmSync(path);
				} catch {
					/* foreign or absent file is preserved */
				}
			}
		}
		try {
			releaseLaunchLease(store, project, sid, nonce);
		} catch (error) {
			log(`LAUNCH-CLEANUP ${item} — lease release failed: ${String(error)}`);
		}
	}
};

const main = async (): Promise<void> => {
	if (SHOW_CAPSULE) {
		console.log(
			sh([
				process.execPath,
				`${BIN}/coord.ts`,
				"capsule",
				"get",
				"--as",
				SHOW_CAPSULE,
			]),
		);
		return;
	}
	// prune: dead entries leave lanes.json (history keeps the audit); a worktree
	// with a live claude/codex cwd is alive no matter what the pid says —
	// daemonized `claude -p` re-parents away from the recorded pid within minutes.
	const lanes = loadLanes();
	const audit = laneAudit();
	// Old automatic claims can outlive their registry rows. Reconstruct the
	// original sid instead of reclaiming it and losing capsule/retry identity.
	const orphaned = run([
		process.execPath,
		`${BIN}/work.ts`,
		"orphaned",
		"--json",
	]);
	if (orphaned.code === 0) {
		try {
			const candidates = recoverableClaims(
				JSON.parse(orphaned.out),
				new Set(lanes.map((l) => l.sid)),
				Date.now(),
				isOwnerGated,
				hostname(),
			);
			const slots = Math.max(
				0,
				TARGET - [...audit.values()].filter(Boolean).length,
			);
			for (const row of candidates
				.filter((r) => !ITEM || r.id === ITEM)
				.slice(0, slots)) {
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
		} catch {} // old prefixes without --json support cannot authorize recovery
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
	// resume candidates: dead dispatched lanes whose item is still CLAIMED by
	// them (state on the graph) — re-dispatch with the same sid so the capsule
	// fact (lane.<sid>.capsule) and the claim both carry over.
	const resumeOf = new Map<string, Lane>();
	for (const l of lanes.filter(
		(x) => !live.includes(x) && (!ITEM || x.item === ITEM),
	)) {
		if (worktreeLive(l.worktree)) continue; // raced between filter and here
		const show = run([
			process.execPath,
			`${BIN}/work.ts`,
			"show",
			l.item,
			"--json",
		]);
		if (show.code !== 0 || !isResumableClaim(show.out, l.item, l.sid)) continue;
		resumeOf.set(l.item, l);
	}
	const dispatched: string[] = [];
	for (const [, resume] of resumeOf) {
		if (live.length + dispatched.length >= TARGET) break;
		const out = await dispatchItem(resume.item, live, resume);
		if (out) dispatched.push(out);
	}
	if (ITEM && !live.some((l) => l.item === ITEM) && !resumeOf.has(ITEM)) {
		const out = await dispatchItem(ITEM, live);
		if (out) dispatched.push(out);
	}
	// fresh READY pool (id order = FIFO priority; `work ready` already gates on
	// requires/blocks deps AND on DONE-but-unmerged dep shas via depsMet).
	// Skipped entirely for an explicit --item — that caller already did its
	// own priority analysis and must not be drowned out by the FIFO pool.
	const ready = ITEM
		? []
		: parseReady(run([process.execPath, `${BIN}/work.ts`, "ready"]).out).filter(
				(r) =>
					!live.some((l) => l.item === r.id) &&
					!resumeOf.has(r.id) &&
					!isOwnerGated(r.title),
			);
	for (const r of ready) {
		if (live.length + dispatched.length >= TARGET) break;
		const out = await dispatchItem(r.id, live);
		if (out) dispatched.push(out);
	}
	// daemonized-pid resolve: the `claude -p` parent re-parents away from
	// proc.pid within minutes; one settle + lsof cwd scan re-points fresh
	// entries so the pid guard and `lanes` stay honest.
	if (dispatched.some((d) => d.includes("(pid "))) {
		await Bun.sleep(3000);
		const listing = sh([
			"lsof",
			"-a",
			"-p",
			sh(["ps", "-axo", "pid=,comm="])
				.split("\n")
				.filter((l) => /claude|codex/.test(l))
				.map((l) => Number.parseInt(l.trim(), 10))
				.join(","),
			"-d",
			"cwd",
			"-Fn",
		]);
		const byCwd = new Map<string, number>();
		let cur = "";
		for (const line of listing.split("\n")) {
			if (line.startsWith("p")) cur = line.slice(1);
			if (line.startsWith("n")) {
				const wt = byCwd.get(line.slice(1));
				byCwd.set(
					line.slice(1),
					cur && (!wt || Number(cur) > wt) ? Number(cur) : (wt ?? 0),
				);
			}
		}
		for (const l of live) {
			const resolved = byCwd.get(l.worktree);
			if (resolved && laneProcessIdentity(l) === false) {
				l.pid = resolved;
				dispatched.push(`${l.item}→${l.sid}(daemonized pid ${resolved})`);
			}
		}
	}
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
	console.log(
		`lanes live: ${live.length}/${TARGET}${dispatched.length ? ` — dispatched: ${dispatched.join(", ")}` : " — pool drained or lanes busy"}`,
	);
	// W463: a governance refusal is an ERROR the caller must see — the run
	// never reads as a clean "pool drained" exit.
	if (governanceRefusals.length > 0)
		console.log(
			`governance: ${governanceRefusals.length} dispatch(es) REFUSED (fail-closed) — ${governanceRefusals.join(", ")}`,
		);
	if (!ITEM && ready.length === 0 && resumeOf.size === 0)
		console.log(
			"READY pool empty — register work or pull the next epic forward",
		);
	if (governanceRefusals.length > 0) process.exitCode = 1;
};

if (import.meta.main) {
	if (SHOW_CAPSULE || !DRY) mkdirSync(FLEET, { recursive: true });
	await main();
}
