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
//                                [--show-capsule <sid>]
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { DEFAULT_ALLOWED_TOOLS, laneEnv, spawnClaude } from "./lib/lane.ts";
import { applyInsertion, insertionCtx } from "./lib/insertion.ts";
import { readBoardSettings } from "../hooks/lib/board-config.ts";
import { resolveHub } from "../hooks/lib/hub-locate.ts";

const argv = process.argv.slice(2);
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const TARGET = Number(val("--target") ?? 3);
const REPO = val("--repo") ?? process.cwd();
const DRY = argv.includes("--dry-run");
// explicit single-item dispatch (W145 docstring promised this, never wired
// up): bypasses the FIFO ready-pool pick so a caller with its own priority
// analysis (collision-checked picks, owner direction) can target one item
// precisely instead of whatever sorts first in `work ready`.
const ITEM = val("--item");
const NO_BELT = argv.includes("--no-belt");
const SHOW_CAPSULE = val("--show-capsule");
const BIN = `${process.env.HOME}/.claude/hooks/suspenders/bin`;
const FLEET = `${REPO}/.fleet`;
const LANES_JSON = `${FLEET}/lanes.json`;
const LOOP_LOG = `${FLEET}/loop.log`;

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
		for (const line of readFileSync(`${REPO}/.prefer`, "utf8").split("\n")) {
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
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const log = (msg: string): void => {
	mkdirSync(FLEET, { recursive: true });
	appendFileSync(LOOP_LOG, `${new Date().toISOString()} ${msg}\n`);
};
const loadLanes = (): Lane[] => {
	try {
		return JSON.parse(readFileSync(LANES_JSON, "utf8")) as Lane[];
	} catch {
		return [];
	}
};
const saveLanes = (lanes: Lane[]): void => {
	mkdirSync(FLEET, { recursive: true });
	writeFileSync(LANES_JSON, JSON.stringify(lanes, null, 2));
};

/** live claude/codex process with cwd inside the worktree — pid-independent
 *  liveness, same contract-free probe fleet-loop uses for its retire guard. */
const worktreeLive = (wt: string): boolean => {
	const pids = sh(["ps", "-axo", "pid=,comm="])
		.split("\n")
		.filter((l) => /claude|codex/.test(l))
		.map((l) => Number.parseInt(l.trim(), 10));
	if (pids.length === 0) return false;
	const listing = sh([
		"lsof",
		"-a",
		"-p",
		pids.join(","),
		"-d",
		"cwd",
		"-Fpcn",
	]);
	let pid = 0;
	for (const line of listing.split("\n")) {
		if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10) || pid;
		else if (line.startsWith("n") && line.slice(1).startsWith(wt)) return true;
	}
	return false;
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** parse `work ready` rows (renderRow format, ANSI-stripped): glyph, id,
 *  truncated title. The title is for gating/log lines only — the brief must
 *  carry the FULL spec from `work show` (gaps W279 phantom-lane lesson). */
export const parseReady = (stdout: string): { id: string; title: string }[] =>
	stdout
		.replace(ANSI, "")
		.split("\n")
		.map((l) => /^\s*·\s+(W[\d.]+)\s+(.+)$/.exec(l.trimEnd()))
		.map((m) => (m ? { id: m[1], title: m[2].trim() } : null))
		.filter((x): x is { id: string; title: string } => !!x);

/** decision-gated items never ride the automagic — they surface to the owner. */
export const isOwnerGated = (title: string): boolean =>
	/OWNER-GATED|OWNER GATE|\bGATED\b|\bHELD\b|NEED_DECISION|\bDECISION\b|PAUSED/i.test(
		title,
	);

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
}): string => {
	const parts = [
		`You are lane "${o.sid}", Work Graph item ${o.item}, repo ${o.repo ?? REPO}. English only.`,
		``,
		`IDENTITY: executor ${o.agent ?? "claude"}. [HUB] prefixes are labels — traffic routes through that hub's gateway.`,
		``,
		`MISSION (from work show):`,
		o.showOut.replace(ANSI, "").trim(),
		``,
		`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
		`Inbox: before planning and again before finishing, check bun ${BIN}/coord.ts inbox --as ${o.sid} — coordinator and board messages arrive there.`,
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
		`2. bun ${BIN}/work.ts done ${o.item} --sha <branch-head> --as ${o.sid}`,
		`3. bun ${BIN}/coord.ts fact set finding.${o.item.toLowerCase()} --text "<one-line headline + how to verify>" --source ${o.sid}`,
		``,
		`IDENTITY: prefix every progress note, inbox reply and your final report lines with [${o.item}] plus a locality tag when it aids scanning — [${o.item}·local], [${o.item}·remote], [${o.item}·sim], [${o.item}·buckle] — the owner's agent list shows your live activity text, and the id is what ties it to the graph. Humans deep-link your item on the fleet board as #task=${o.item}${process.env.FLEET_BOARD_URL ? ` (full URL: ${process.env.FLEET_BOARD_URL}/#task=${o.item})` : ""}; include the link in your final report.`,
		`CRAFT: ≤25-line anchored edits per write (content gate parse-checks; splice via /tmp chunks for larger); build verify every ~3rd edit; GUI deliverables get a headless-Chrome render-and-look pass against the LIVE surface with real data — report what you saw; evidence before claims, always.`,
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

export const sidOf = (item: string): string =>
	`autow${item.replace(/^W/, "").replace(/\./g, "")}`;

/** one item → claim, worktree, brief, daemonized lane. Returns the summary
 *  fragment or null when the item cannot be taken (claimed elsewhere). */
const dispatchItem = async (
	item: string,
	lanes: Lane[],
	resume?: Lane,
): Promise<string | null> => {
	const sid = resume?.sid ?? sidOf(item);
	const wt = `${REPO}/.worktrees/${item}`;
	if (DRY) {
		// read-only end to end: no claim, no worktree, no brief file, no spawn
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		const capsule = capsuleGet(sid);
		const branch = existsSync(wt)
			? sh(["git", "-C", wt, "branch", "--show-current"]) ||
				`suspenders/${item}`
			: `suspenders/${item}`;
		const attempt = resume?.attempt !== undefined ? resume.attempt + 1 : 0;
		const pick = execPick(attempt);
		console.log(`DRY dispatch ${item} → ${sid}${capsule ? " (RESUME)" : ""}`);
		if (pick.chainLen > 1)
			console.log(
				`DRY chain attempt ${pick.chainIdx}/${pick.chainLen - 1} -> ${pick.agent}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
			);
		console.log(
			composeBrief({
				item,
				showOut: show.out,
				sid,
				branch,
				worktree: wt,
				capsule,
				agent: pick.agent,
			}),
		);
		return `${item}→${sid}(dry)`;
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
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		if (!show.out.includes(sid)) {
			console.log(
				`SKIP ${item} — claimed elsewhere: ${take.out.split("\n")[0]}`,
			);
			return null;
		}
		// claimed by this sid from a previous dispatch attempt — resume
	}
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
	const attempt = resume?.attempt !== undefined ? resume.attempt + 1 : 0;
	const pick = execPick(attempt);
	if (pick.chainLen > 1)
		console.log(
			`NOTE — .prefer chain attempt ${pick.chainIdx}/${pick.chainLen - 1}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
		);
	const brief = composeBrief({
		item,
		showOut: show.out,
		sid,
		branch,
		worktree: wt,
		capsule,
		agent: pick.agent,
	});
	const briefFile = `${FLEET}/brief-${sid}.md`;
	mkdirSync(FLEET, { recursive: true });
	writeFileSync(briefFile, brief);
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
		const ctx = insertionCtx(env, pick.model);
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
	}
	const bin = Bun.which(pick.bin);
	if (!bin) {
		console.log(`SKIP — executor binary not found on PATH: ${pick.bin}`);
		return null;
	}
	const prompt = `Read ${briefFile} and execute it fully.`;
	const laneLog = `${FLEET}/lane-${sid}.log`;
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
						]
					: undefined,
	});
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
		attempt: pick.chainIdx,
	};
	lanes.push(entry);
	log(`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch})${hubNote}`);
	console.log(
		`dispatched ${item} → ${sid} (pid ${proc.pid})${capsule ? " — resumed from capsule" : ""}${hubNote}`,
	);
	return `${item}→${sid}(pid ${proc.pid})`;
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
	const live = lanes.filter((l) => alive(l.pid) || worktreeLive(l.worktree));
	// resume candidates: dead dispatched lanes whose item is still CLAIMED by
	// them (state on the graph) — re-dispatch with the same sid so the capsule
	// fact (lane.<sid>.capsule) and the claim both carry over.
	const resumeOf = new Map<string, Lane>();
	for (const l of lanes.filter((x) => !live.includes(x))) {
		if (worktreeLive(l.worktree)) continue; // raced between filter and here
		const show = run([process.execPath, `${BIN}/work.ts`, "show", l.item]);
		if (!/state:\s*(CLAIMED|RUNNING)/.test(show.out)) continue;
		if (!show.out.includes(l.sid)) continue;
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
			if (resolved && (l.pid === 0 || !alive(l.pid))) {
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
	console.log(
		`lanes live: ${live.length}/${TARGET}${dispatched.length ? ` — dispatched: ${dispatched.join(", ")}` : " — pool drained or lanes busy"}`,
	);
	if (!ITEM && ready.length === 0 && resumeOf.size === 0)
		console.log(
			"READY pool empty — register work or pull the next epic forward",
		);
};

if (import.meta.main) {
	if (SHOW_CAPSULE || !DRY) mkdirSync(FLEET, { recursive: true });
	await main();
}
