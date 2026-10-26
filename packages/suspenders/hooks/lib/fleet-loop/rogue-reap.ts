// hooks/lib/fleet-loop/rogue-reap.ts — W827: the rogue-serve reaper. The W266.3
// rogue-sweep SPOTS plane processes outside launchd supervision; this lib
// REAPS the lane-leak class: serve processes (buckle server, fleet-board,
// router-shim, dashboard, coord store) running from fleet worktree or
// fleet-ish tmp copies no live lane claim covers — leaked serves from
// merged/reaped lanes holding old code (2026-10-19 incident: 100+ bun
// serves from W373/W798/W359 worktrees on random ports; W973 incident:
// 177 fleet-board serves surviving reap cycles from `.worktrees/<name>`
// dirs AND `/tmp/w<digits>-base` A/B copies, incl. dangling worktrees
// lsof can no longer resolve). Guard chain, every link mandatory before
// a kill:
//   serve-marker cmd → NOT launchd-supervised (label pids + descendants)
//   → fleet scope: cwd (lsof) inside THIS repo's .worktrees/<name>, or
//   the commandline names a .worktrees/<name> path / fleet-ish tmp dir
//   (W973 reap-by-commandline) → worktree NOT protected (live/unknown
//   lane verdict or CLAIMED/RUNNING item; tmp stems map to their
//   w<digits> graph id) → SIGTERM, escalating to SIGKILL past the grace
//   window (state file survives restarts, pid→firstSeen).
// The kill batch is bounded (maxKill, default 200/cycle — W973: the cap
// must still drain a 177-flood in one cycle) and the report counts
// reaped vs survivors. A merged-and-clean stale worktree is pruned
// alongside (git worktree remove — reference-before-delete, -d only;
// dirty trees never touched). Dry-run is the default: without --act
// nothing is killed, written, or removed — the report is the product.
// Darwin-only (launchctl ground truth), launchd com.suspenders.* services
// are never candidates, and `.fleet/rogue-reap-paused` pauses everything
// (the retires-paused idiom).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { parseLaunchctlList, parsePs, supervisedPids } from "./rogue-sweep.ts";
import { readJsonSync } from "./runtime.ts";
import { laneVerdict, type LaneRef } from "../lanes/lane-liveness.ts";

// trailing literals of the fleet's serve entrypoints — the same
// last-segments discipline as rogue-sweep's markerOf (placeholder tokens
// and dot-dirs are install-machine substitution; the literal tail matches
// both the installed prefix and a checkout run)
export const SERVE_MARKERS: readonly string[] = [
	"buckle/src/server.ts",
	"fleet-board.ts",
	"router-shim.ts",
	"dashboard.ts",
	"store-server.ts",
];

// W973: fleet-ish tmp dirs host A/B lane copies (w894-base, w858-base,
// w970-ab) whose serves the .worktrees-only cwd scope never matched. The
// first segment under a tmp root must be a w<digits> stem with an
// optional suffix chain; exact-or-subdir, the insideWorktrees discipline.
export const FLEET_TMP_SEGMENT = /^w\d+(?:[-_.][a-z0-9._-]+)*$/i;
export const FLEET_TMP_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	tmpdir(),
];

/** The fleet-ish tmp root dir a path sits under (/tmp, /private/tmp, OS
 *  tmpdir; first segment must match FLEET_TMP_SEGMENT), or null. */
export function fleetTmpDir(path: string): string | null {
	const p = resolve(path);
	for (const root of FLEET_TMP_ROOTS) {
		const r = `${root.replace(/\/+$/, "")}/`;
		if (p === root || !p.startsWith(r)) continue;
		const name = p.slice(r.length).split("/")[0] ?? "";
		if (name === "" || name === "." || name === "..") return null;
		if (!FLEET_TMP_SEGMENT.test(name)) return null;
		return `${r}${name}`;
	}
	return null;
}

export type WorktreeEntry = {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
};

// `git worktree list --porcelain` — blocks of worktree/HEAD/branch/bare/
// detached/locked lines separated by blank lines.
export function parseWorktreeList(out: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let cur: WorktreeEntry | null = null;
	const flush = (): void => {
		if (cur) entries.push(cur);
		cur = null;
	};
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			cur = {
				path: line.slice(9),
				head: null,
				branch: null,
				detached: false,
				bare: false,
				locked: false,
			};
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("HEAD ")) cur.head = line.slice(5);
		else if (line.startsWith("branch "))
			cur.branch = line.slice("branch ".length);
		else if (line === "bare") cur.bare = true;
		else if (line === "detached") cur.detached = true;
		else if (line.startsWith("locked")) cur.locked = true;
	}
	flush();
	return entries;
}

/** The `.worktrees/<name>` dir a cwd sits in (exact-or-subdir — a cwd in a
 *  SUBDIR of the tree counts, `.worktrees/W12` never matches `W123`), or
 *  null when outside. */
export function insideWorktrees(cwd: string, repo: string): string | null {
	const root = `${resolve(repo)}/.worktrees`;
	if (cwd === root || !cwd.startsWith(`${root}/`)) return null;
	const name = cwd.slice(root.length + 1).split("/")[0] ?? "";
	if (name === "" || name === "." || name === "..") return null;
	return `${root}/${name}`;
}

export type ReapSig = "SIGTERM" | "SIGKILL";

/** The work-graph item a scope dir stands for: the basename, except a
 *  fleet-ish tmp name resolves to its w<digits> stem as the graph id
 *  (w894-base → W894) so claimState protection applies to tmp copies. */
export function worktreeItem(wt: string): string {
	const name = basename(wt);
	if (FLEET_TMP_SEGMENT.test(name)) {
		return (/^w\d+/i.exec(name)?.[0] ?? name).toUpperCase();
	}
	return name;
}

const escapeRe = (s: string): string =>
	s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** W973 reap-by-commandline: a serve whose commandline names a fleet
 *  `.worktrees/<name>` path or a fleet-ish tmp dir is in scope even when
 *  lsof cwd fails (dangling worktree dirs). Null = no fleet scope. */
export function cmdlineScope(cmd: string, repo: string): string | null {
	const root = resolve(repo);
	const wt =
		new RegExp(`${escapeRe(root)}/\\.worktrees/([A-Za-z0-9._-]+)`).exec(
			cmd,
		)?.[1] ?? null;
	if (wt) return `${root}/.worktrees/${wt}`;
	const m = /(?:^|[\s"'=])(\/private\/tmp|\/tmp)\/([A-Za-z0-9._-]+)/.exec(cmd);
	if (m?.[2] === undefined || !FLEET_TMP_SEGMENT.test(m[2])) return null;
	return `${m[1]}/${m[2]}`;
}

export type ReapCandidate = {
	pid: number;
	cmd: string;
	worktree: string;
	item: string;
	sig: ReapSig;
};

export type PruneVerdict = {
	worktree: string;
	branch: string;
	action: "removed" | "would-remove" | "skipped";
	why: string;
};

export type ReapReport = {
	candidates: ReapCandidate[];
	pruned: PruneVerdict[];
	/** W973: kill actions that succeeded this cycle (bounded by maxKill) */
	reaped: number;
	/** W973: candidates found but not reaped (cap-deferred or kill-failed) */
	survivors: number;
	dryRun: boolean;
	paused: boolean;
};

/** W973: kill batches are bounded so a flood drains fast but a runaway
 *  reaper can never kill unboundedly; 200 still clears a 177-flood in
 *  one cycle (the W973 acceptance: near-0 after one cycle). */
export const DEFAULT_MAX_KILL = 200;

export interface RogueReapDeps {
	repo: string;
	/** false = dry-run: report only, nothing killed/written/removed */
	act: boolean;
	/** merge target the prune pass checks mergedness against (default main) */
	main?: string;
	/** TERM → KILL escalation age over the state file (default 120s) */
	graceMs?: number;
	/** W973: bound on kill actions per cycle (default DEFAULT_MAX_KILL) */
	maxKill?: number;
	now?: () => number;
	psOut?: () => string;
	launchctlList?: () => string;
	/** lsof-style cwd probe; null = unknown (unknown never authorizes) */
	cwdOf?: (pid: number) => string | null;
	lanes?: () => LaneRef[];
	/** tri-state lane verdict; default THE surface (lane-liveness) */
	verdictOf?: (l: LaneRef) => "alive" | "dead" | "unknown";
	/** work_items.state lookup; CLAIMED/RUNNING protects */
	claimState?: (item: string) => string | null | undefined;
	/** git runner bound to the repo (args after `git -C <repo>`) */
	git?: (args: string[]) => { code: number; out: string };
	kill?: (pid: number, sig: ReapSig) => boolean;
	statePath?: string;
	log?: (msg: string) => void;
}

const spawnOut = (cmd: string[]): string => {
	try {
		const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return p.stdout ? new TextDecoder().decode(p.stdout) : "";
	} catch {
		return "";
	}
};

const lsofCwd = (pid: number): string | null => {
	try {
		const out = spawnOut(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
		for (const line of out.split("\n")) {
			if (line.startsWith("n")) return line.slice(1);
		}
	} catch {}
	return null;
};

const defaultGit =
	(repo: string) =>
	(args: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const out =
			`${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim();
		return { code: p.exitCode ?? 1, out };
	};

/** Protection verdict: WHY a worktree's serves are hands-off, or null. A
 *  dead lane entry does not protect; unknown does (a bulk reaper acts only
 *  on positive death evidence — the W610/W51 monitor doctrine). */
export function worktreeProtected(
	wt: string,
	lanes: LaneRef[],
	verdictOf: (l: LaneRef) => "alive" | "dead" | "unknown",
	claimState: ((item: string) => string | null | undefined) | undefined,
): string | null {
	for (const l of lanes) {
		if (!l.worktree) continue;
		const lw = resolve(l.worktree);
		if (lw !== wt && !wt.startsWith(`${lw}/`)) continue;
		if (verdictOf(l) !== "dead") return `lane ${l.sid} not dead`;
	}
	const st = claimState?.(worktreeItem(wt));
	if (st === "CLAIMED" || st === "RUNNING")
		return `item ${worktreeItem(wt)} ${st}`;
	return null;
}

/** W827 prune pass: merged-and-clean `.worktrees/*` trees, no live claim —
 *  reference-before-delete (refs/recover pin), `worktree remove`, `-d`
 *  only. Unmerged never prunes (a failed rev-list reads UNMERGED, the
 *  runtime.ts doctrine); dirty/unreadable trees skip loudly. */
export function pruneStaleWorktrees(ctx: {
	repo: string;
	main: string;
	act: boolean;
	git: (args: string[]) => { code: number; out: string };
	protectedReason: (wt: string) => string | null;
	log?: (msg: string) => void;
	now?: () => number;
}): PruneVerdict[] {
	const out: PruneVerdict[] = [];
	const entries = parseWorktreeList(
		ctx.git(["worktree", "list", "--porcelain"]).out,
	);
	for (const e of entries) {
		if (e.bare || e.detached || e.locked || !e.branch) continue;
		const wt = resolve(e.path);
		if (insideWorktrees(wt, ctx.repo) !== wt) continue;
		const branch = e.branch.replace(/^refs\/heads\//, "");
		const prot = ctx.protectedReason(wt);
		if (prot !== null) {
			out.push({ worktree: wt, branch, action: "skipped", why: prot });
			continue;
		}
		// a failed rev-list reads UNMERGED — never pruned (runtime.ts doctrine)
		const ahead = ctx.git(["rev-list", "--count", `${ctx.main}..${branch}`]);
		const n = ahead.out === "" ? Number.NaN : Number(ahead.out.trim());
		if (ahead.code !== 0 || !Number.isFinite(n) || n > 0) continue;
		const st = ctx.git(["-C", wt, "status", "--porcelain"]);
		if (st.code !== 0 || st.out.trim() !== "") {
			out.push({
				worktree: wt,
				branch,
				action: "skipped",
				why: "dirty or unreadable",
			});
			continue;
		}
		if (!ctx.act) {
			out.push({
				worktree: wt,
				branch,
				action: "would-remove",
				why: "merged+clean, no live claim",
			});
			continue;
		}
		// REFERENCE BEFORE DELETE (retire.ts doctrine): pin the tip so a later
		// aggressive prune can never orphan the commits
		const tip = e.head ?? ctx.git(["rev-parse", branch]).out;
		if (tip)
			ctx.git([
				"update-ref",
				`refs/recover/${branch.replace(/\//g, "-")}-${Math.floor((ctx.now ?? ((): number => Date.now()))())}`,
				tip,
			]);
		let rm = ctx.git(["worktree", "remove", wt]);
		if (rm.code !== 0) {
			ctx.git(["worktree", "prune"]);
			rm = ctx.git(["worktree", "remove", wt]);
		}
		if (rm.code !== 0) {
			out.push({
				worktree: wt,
				branch,
				action: "skipped",
				why: `worktree remove failed: ${rm.out.slice(0, 120)}`,
			});
			continue;
		}
		const del = ctx.git(["branch", "-d", branch]);
		const verdict: PruneVerdict = {
			worktree: wt,
			branch,
			action: del.code === 0 ? "removed" : "skipped",
			why:
				del.code === 0
					? "merged+clean, pruned"
					: `branch -d failed: ${del.out.slice(0, 120)}`,
		};
		out.push(verdict);
		ctx.log?.(
			`PRUNED ${branch} — worktree ${wt} (merged+clean, no live claim)`,
		);
	}
	return out;
}

export function createRogueReap(deps: RogueReapDeps): {
	reap: () => ReapReport;
} {
	const repo = resolve(deps.repo);
	const now = deps.now ?? ((): number => Date.now());
	const graceMs = deps.graceMs ?? 120_000;
	const statePath = deps.statePath ?? `${repo}/.fleet/rogue-reap.json`;
	const log = deps.log ?? ((): void => {});
	const act = deps.act;
	const git = deps.git ?? defaultGit(repo);
	const kill =
		deps.kill ??
		((pid: number, sig: ReapSig): boolean => {
			try {
				process.kill(pid, sig);
				return true;
			} catch {
				return false;
			}
		});
	const empty = (paused: boolean): ReapReport => ({
		candidates: [],
		pruned: [],
		reaped: 0,
		survivors: 0,
		dryRun: !act,
		paused,
	});
	return {
		reap: (): ReapReport => {
			if (process.platform !== "darwin") {
				log(
					"REAP-SKIP non-darwin — rogue-sweep parity (launchctl ground truth)",
				);
				return empty(false);
			}
			if (existsSync(`${repo}/.fleet/rogue-reap-paused`)) {
				log("REAP-PAUSED — .fleet/rogue-reap-paused present");
				return empty(true);
			}
			const ps =
				deps.psOut?.() ?? spawnOut(["ps", "-axo", "pid=,ppid=,command="]);
			const lc = deps.launchctlList?.() ?? spawnOut(["launchctl", "list"]);
			if (ps === "" && lc === "") {
				log(
					"REAP-EMPTY — ps/launchctl produced nothing, never kills on no evidence",
				);
				return empty(false);
			}
			const rows = parsePs(ps);
			const supervised = supervisedPids(rows, [
				...parseLaunchctlList(lc).values(),
			]);
			const lanes = deps.lanes ?? ((): LaneRef[] => []);
			const verdictOf = deps.verdictOf ?? ((l: LaneRef) => laneVerdict(l));
			const protect = (wt: string): string | null =>
				worktreeProtected(wt, lanes(), verdictOf, deps.claimState);
			const state = act
				? (readJsonSync<Record<string, number>>(statePath) ?? {})
				: {};
			const next: Record<string, number> = {};
			const candidates: ReapCandidate[] = [];
			const maxKill = deps.maxKill ?? DEFAULT_MAX_KILL;
			let reaped = 0;
			let killAttempts = 0;
			for (const r of rows) {
				if (supervised.has(r.pid)) continue;
				if (!SERVE_MARKERS.some((m) => r.cmd.includes(m))) continue;
				const cwd = (deps.cwdOf ?? lsofCwd)(r.pid);
				// W973 fleet scope: cwd-derived (worktree OR fleet-ish tmp), else
				// the commandline's .worktrees/tmp path literal (dangling cwd OK)
				const wt =
					(cwd ? insideWorktrees(cwd, repo) : null) ??
					(cwd ? fleetTmpDir(cwd) : null) ??
					cmdlineScope(r.cmd, repo);
				if (!wt) continue; // no fleet scope — never a candidate
				if (protect(wt) !== null) continue;
				const key = String(r.pid);
				const first = state[key];
				const sig: ReapSig =
					first !== undefined && now() - first >= graceMs
						? "SIGKILL"
						: "SIGTERM";
				if (act) {
					// W973: bounded batch — past the cap the serve is deferred to
					// the next cycle (never state-tracked: fresh TERM next fire)
					if (killAttempts >= maxKill) {
						log(
							`DEFERRED pid=${r.pid} worktree=${wt} cap=${maxKill} ${r.cmd.slice(0, 120)}`,
						);
					} else {
						killAttempts++;
						next[key] = first ?? now();
						const ok = kill(r.pid, sig);
						if (ok) reaped++;
						log(
							`${ok ? "REAPED" : "REAP-FAIL"} pid=${r.pid} sig=${sig} worktree=${wt} ${r.cmd.slice(0, 120)}`,
						);
					}
				} else {
					log(`WOULD-REAP pid=${r.pid} worktree=${wt} ${r.cmd.slice(0, 120)}`);
				}
				candidates.push({
					pid: r.pid,
					cmd: r.cmd.slice(0, 160),
					worktree: wt,
					item: worktreeItem(wt),
					sig: act ? sig : "SIGTERM",
				});
			}
			if (act) {
				// escalation bookkeeping: firstSeen per reaped pid survives
				// restarts; pids that vanished leave the state with them
				try {
					mkdirSync(`${repo}/.fleet`, { recursive: true });
					writeFileSync(statePath, `${JSON.stringify(next, null, "\t")}\n`, {
						mode: 0o600,
					});
				} catch {}
			}
			const pruned = pruneStaleWorktrees({
				repo,
				main: deps.main ?? "main",
				act,
				git,
				protectedReason: protect,
				log,
				now,
			});
			return {
				candidates,
				pruned,
				reaped,
				survivors: candidates.length - reaped,
				dryRun: !act,
				paused: false,
			};
		},
	};
}
