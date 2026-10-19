// hooks/lib/rogue-reap.ts — W827: the rogue-serve reaper. The W266.3
// rogue-sweep SPOTS plane processes outside launchd supervision; this lib
// REAPS the lane-leak class: serve processes (buckle server, fleet-board,
// router-shim, dashboard, coord store) whose cwd sits inside a
// `.worktrees/<name>` dir no live lane claim covers — leaked serves from
// merged/reaped lanes holding old code (2026-10-19 incident: 100+ bun
// serves from W373/W798/W359 worktrees on random ports). Guard chain,
// every link mandatory before a kill:
//   serve-marker cmd → NOT launchd-supervised (label pids + descendants)
//   → cwd (lsof) inside THIS repo's .worktrees/<name> → worktree NOT
//   protected (live/unknown lane verdict or CLAIMED/RUNNING item)
//   → SIGTERM, escalating to SIGKILL past the grace window (state file
//   survives restarts, pid→firstSeen).
// A merged-and-clean stale worktree is pruned alongside (git worktree
// remove — reference-before-delete, -d only; dirty trees never touched).
// Dry-run is the default: without --act nothing is killed, written, or
// removed — the report is the product. Darwin-only (launchctl ground
// truth), launchd com.suspenders.* services are never candidates, and
// `.fleet/rogue-reap-paused` pauses everything (the retires-paused idiom).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	parseLaunchctlList,
	parsePs,
	supervisedPids,
} from "./fleet-loop/rogue-sweep.ts";
import { readJsonSync } from "./fleet-loop/runtime.ts";
import { laneVerdict, type LaneRef } from "./lane-liveness.ts";

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
	dryRun: boolean;
	paused: boolean;
};

export interface RogueReapDeps {
	repo: string;
	/** false = dry-run: report only, nothing killed/written/removed */
	act: boolean;
	/** merge target the prune pass checks mergedness against (default main) */
	main?: string;
	/** TERM → KILL escalation age over the state file (default 120s) */
	graceMs?: number;
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
	const st = claimState?.(basename(wt));
	if (st === "CLAIMED" || st === "RUNNING") return `item ${basename(wt)} ${st}`;
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
			for (const r of rows) {
				if (supervised.has(r.pid)) continue;
				if (!SERVE_MARKERS.some((m) => r.cmd.includes(m))) continue;
				const cwd = (deps.cwdOf ?? lsofCwd)(r.pid);
				if (!cwd) continue; // unknown cwd never authorizes a kill
				const wt = insideWorktrees(cwd, repo);
				if (!wt) continue;
				if (protect(wt) !== null) continue;
				const key = String(r.pid);
				const first = state[key];
				const sig: ReapSig =
					first !== undefined && now() - first >= graceMs
						? "SIGKILL"
						: "SIGTERM";
				if (act) {
					next[key] = first ?? now();
					const ok = kill(r.pid, sig);
					log(
						`${ok ? "REAPED" : "REAP-FAIL"} pid=${r.pid} sig=${sig} worktree=${wt} ${r.cmd.slice(0, 120)}`,
					);
				} else {
					log(`WOULD-REAP pid=${r.pid} worktree=${wt} ${r.cmd.slice(0, 120)}`);
				}
				candidates.push({
					pid: r.pid,
					cmd: r.cmd.slice(0, 160),
					worktree: wt,
					item: basename(wt),
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
			return { candidates, pruned, dryRun: !act, paused: false };
		},
	};
}
