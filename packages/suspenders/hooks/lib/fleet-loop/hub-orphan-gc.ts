// hooks/lib/fleet-loop/hub-orphan-gc.ts — W2321.5: the hub orphan GC.
// The MultiKueue adopt (docs/design/multikueue-hub-dispatch.md §2, runGC at
// multikueuecluster.go:762): remote objects the manager creates carry an
// ORIGIN label, and GC deletes only labeled objects whose local counterpart
// is gone — and only while connected to the authority's records. Fleet's
// hub-exec artifacts (lane worktrees under a hub repo, serve processes run
// from them) are the same class: dispatch-minted, claim-scoped, leaked past
// their claim's life. The GC law, every link mandatory:
//   origin marker → the worktree carries .fleet/lane-context.json (the
//   dispatch-written claim context — the MultiKueueOriginLabel analog).
//   "File exists and nothing knows it" NEVER authorizes deletion.
//   → authority term → the marker's item is TERMINAL at the authority
//   (DONE/FAILED/CANCELLED/SUPERSEDED/SHATTERED). A live/absent/unknown
//   claim never authorizes (fail-closed: unknown ≠ dead, the W51 doctrine);
//   an unreachable authority store degrades the whole fire to scan-only.
//   → safety shape → clean tree only (dirty skips loudly), merged-or-pushed
//   only (an unpushed unmerged tip is evidence — kept for the merge
//   ladder), refs/recover pin before delete (the rogue-reap doctrine),
//   detached/anonymous trees report, never remove.
// Serve processes whose commandline scopes to a terminal-claim worktree
// (SERVE_MARKER + <repoRoot>/.worktrees/<name>, the W827/W973 discipline)
// get SIGTERM; survivors re-report next fire. Dry-run is the default;
// --act performs. The bin is the CLI face; the maintenance registry fires
// it with --act every 30 min.
import { parsePs } from "./rogue-sweep.ts";
import { cmdlineScope, SERVE_MARKERS, worktreeItem } from "./rogue-reap.ts";

/** Terminal claim states at the authority — the only deletion license.
 * SHATTERED trees are the parent of an executed split; the kept child
 * owns the live claim, the parent's claim is closed history. */
export const TERMINAL_STATES: readonly string[] = [
	"DONE",
	"FAILED",
	"CANCELLED",
	"SUPERSEDED",
	"SHATTERED",
];

/** The profile slice this GC walks — flattened from a stack.json hub
 * profile with a lane_gc section (repo_root = the hub-side fleet clone
 * lanes' worktrees mint under). */
export interface HubGcTarget {
	name: string;
	/** remote host (ssh target); unset = local exec (the desktop shape) */
	ssh?: string;
	/** hub-side fleet clone root (hubs.<label>.lane_gc.repo_root) */
	repoRoot: string;
	/** connect timeout seconds for the ssh leg */
	connectTimeout?: number;
}

/** One discovered origin-marked worktree on the hub. */
export interface HubGcWorktree {
	/** claim item from the lane-context marker ("" when unparsable) */
	item: string;
	worktree: string;
	/** branch short name, "DETACHED" when HEAD is detached */
	branch: string;
	clean: boolean;
}

/** Serve-process candidate (pid-scoped, marker+worktree identified). */
export interface HubGcServe {
	pid: number;
	item: string;
	cmd: string;
}

export type HubGcAction =
	| "reap"
	| "would-reap"
	| "protected"
	| "authority-unreachable"
	| "dirty"
	| "unmerged"
	| "detached";

export interface HubGcRow {
	worktree: string;
	item: string;
	branch: string;
	action: HubGcAction;
	why: string;
}

export interface HubGcReport {
	hub: string;
	rows: HubGcRow[];
	serves: HubGcServe[];
	/** act mode: worktrees the fire actually removed (re-list verified) */
	reaped: number;
	/** act mode: reapable rows still present after the fire */
	survivors: number;
	/** pids TERMed this fire (survivors re-report next fire) */
	killed: number;
	dryRun: boolean;
	/** authority store unreadable — scan-only, nothing classified reapable */
	authorityReachable: boolean;
}

export type HubGcExec = (
	target: HubGcTarget,
	script: string,
) => { code: number; out: string };

/** The authority's claim-state face: item → work_items.state, null when no
 * row, THROWS when the store is unreachable (gcHub catches and degrades to
 * scan-only — connectivity-gated, the MultiKueue law). */
export type ClaimStateFace = (item: string) => string | null;

/** POSIX single-quote quoting for sh -c / ssh argv scripts. Double quotes
 * (JSON.stringify) leave $, backtick, and \ expansions live — and branch
 * names may legally carry $ — so wrap in single quotes and end-quote any
 * embedded single quote: a'b → 'a'\''b'. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One listing leg ON the hub: git worktree list filtered to origin-marked
 * trees (the marker test + branch/clean probes run hub-side — no tree
 * contents travel), plus the raw process table for serve scoping. The
 * GCWT rows and ===GC- section markers are this module's wire format. */
export function listScript(t: HubGcTarget): string {
	return [
		"echo ===GC-WORKTREES",
		`git -C ${shQuote(t.repoRoot)} worktree list --porcelain | while IFS= read -r line; do`,
		'  case "$line" in',
		'    "worktree "*)',
		"      wt=${" + "line#worktree }",
		'      ctx="$wt/.fleet/lane-context.json"',
		'      if [ -f "$ctx" ]; then',
		'        item=$(sed -n \'s/.*"item"[ \t]*:[ \t]*"\\([^"]*\\)".*/\\1/p\' "$ctx" 2>/dev/null)',
		'        branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || printf DETACHED)',
		'        if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then st=dirty; else st=clean; fi',
		'        printf \'GCWT\\t%s\\t%s\\t%s\\t%s\\n\' "$item" "$wt" "$branch" "$st"',
		"      fi",
		"      ;;",
		"  esac",
		"done",
		"echo ===GC-PS",
		"ps -axo pid=,ppid=,command= 2>/dev/null || true",
		"echo ===GC-END",
	].join("\n");
}

/** Parse the listing leg's ===GC- sections into worktrees + ps rows. */
export function parseHubGcListing(out: string): {
	worktrees: HubGcWorktree[];
	ps: ReturnType<typeof parsePs>;
} {
	const worktrees: HubGcWorktree[] = [];
	const ps: ReturnType<typeof parsePs> = [];
	let section: "worktrees" | "ps" | null = null;
	for (const line of out.split("\n")) {
		if (line === "===GC-WORKTREES") {
			section = "worktrees";
			continue;
		}
		if (line === "===GC-PS") {
			section = "ps";
			continue;
		}
		if (line === "===GC-END") break;
		if (section === "worktrees" && line.startsWith("GCWT\t")) {
			const [item, worktree, branch, st] = line.split("\t").slice(1);
			if (!worktree) continue;
			worktrees.push({
				item: item ?? "",
				worktree,
				branch: branch || "DETACHED",
				clean: st !== "dirty",
			});
		} else if (section === "ps") {
			for (const r of parsePs(line)) ps.push(r);
		}
	}
	return { worktrees, ps };
}

/** Terminal verdict at the authority for one claim item — the deletion
 * license. No row (null), an unparsable marker, or a throw from the face
 * all read NOT terminal: unknown never authorizes (the W51 doctrine). */
export function claimTerminal(
	item: string,
	claimState: ClaimStateFace,
): boolean {
	if (!item) return false;
	try {
		return TERMINAL_STATES.includes(claimState(item) ?? "");
	} catch {
		return false;
	}
}

/** Serve processes in hub scope: SERVE_MARKER command whose commandline
 * names a worktree under the hub repo (the W973 reap-by-commandline
 * discipline — remote cwd is unknowable, the commandline is the evidence),
 * whose worktree's claim is terminal at the authority. */
export function scopedServes(
	ps: ReturnType<typeof parsePs>,
	repoRoot: string,
	claimState: ClaimStateFace,
): HubGcServe[] {
	const out: HubGcServe[] = [];
	for (const r of ps) {
		if (!SERVE_MARKERS.some((m) => r.cmd.includes(m))) continue;
		const wt = cmdlineScope(r.cmd, repoRoot);
		if (!wt) continue; // no fleet worktree scope — never a candidate
		const item = worktreeItem(wt);
		if (!claimTerminal(item, claimState)) continue;
		out.push({ pid: r.pid, item, cmd: r.cmd.slice(0, 160) });
	}
	return out;
}

/** The act leg: pin the tip (refs/recover — reference-before-delete), then
 * remove the reaped worktrees, -d the merged branches, TERM the scoped
 * serves. Pids validated numeric (>1); paths/branches ride single
 * quoting — every value came from git's own listing, not free text. */
export function reapScript(
	t: HubGcTarget,
	rows: { worktree: string; branch: string; merged: boolean }[],
	serves: { pid: number }[],
	now = Date.now(),
): string {
	const lines: string[] = [];
	for (const r of rows) {
		const safe = r.branch.replace(/[^A-Za-z0-9._-]/g, "-");
		lines.push(
			`git -C ${shQuote(t.repoRoot)} update-ref refs/recover/${safe}-${Math.floor(now / 1000)} HEAD`,
			`git -C ${shQuote(t.repoRoot)} worktree remove ${shQuote(r.worktree)} || { git -C ${shQuote(t.repoRoot)} worktree prune; git -C ${shQuote(t.repoRoot)} worktree remove ${shQuote(r.worktree)}; }`,
		);
		if (r.merged)
			lines.push(
				`git -C ${shQuote(t.repoRoot)} branch -d ${shQuote(r.branch)}`,
			);
	}
	for (const s of serves)
		if (Number.isInteger(s.pid) && s.pid > 1) lines.push(`kill -TERM ${s.pid}`);
	return lines.join("\n");
}

const unreachableRow = (base: Omit<HubGcRow, "action" | "why">): HubGcRow => ({
	...base,
	action: "authority-unreachable",
	why: "authority store unreachable — scan-only (connectivity-gated GC)",
});

const protectedRow = (base: Omit<HubGcRow, "action" | "why">): HubGcRow => ({
	...base,
	action: "protected",
	why: "claim live or unknown at the authority — fail-closed",
});

/** Pure classification of one origin-marked worktree against the authority
 * term and the merged/pushed safety shape. merged/pushed come from the
 * caller's git ancestry probes (is-ancestor main / origin tip equality). */
export function classifyWorktree(
	w: HubGcWorktree,
	opts: {
		terminal: boolean;
		authorityReachable: boolean;
		merged: boolean;
		pushed: boolean;
		act: boolean;
	},
): HubGcRow {
	const base = { worktree: w.worktree, item: w.item, branch: w.branch };
	if (!opts.authorityReachable) return unreachableRow(base);
	if (!opts.terminal) return protectedRow(base);
	if (!w.clean)
		return { ...base, action: "dirty", why: "worktree dirty — never removed" };
	if (w.branch === "DETACHED")
		return {
			...base,
			action: "detached",
			why: "detached/anonymous HEAD — reported, never removed",
		};
	if (!opts.merged && !opts.pushed)
		return {
			...base,
			action: "unmerged",
			why: "tip neither merged nor pushed — evidence kept for the merge ladder",
		};
	return {
		...base,
		action: opts.act ? "reap" : "would-reap",
		why: `claim terminal + ${opts.merged ? "merged" : "pushed"} — reaped`,
	};
}

/** One hub's fire: list → classify (authority-gated) → act leg → re-list
 * verify. ancestry probes merged/pushed hub-side (git merge-base
 * --is-ancestor against main / origin tip equality); an unreachable or
 * absent ancestry face reads NOT merged/pushed — reapable needs positive
 * evidence. The claimState face throwing = authority unreachable = the
 * whole fire degrades to scan-only (never kills on lost connectivity). */
export function gcHub(
	target: HubGcTarget,
	opts: {
		act: boolean;
		exec: HubGcExec;
		claimState: ClaimStateFace;
		ancestry?: (
			target: HubGcTarget,
			w: HubGcWorktree,
		) => { merged: boolean; pushed: boolean };
	},
): HubGcReport {
	const base: HubGcReport = {
		hub: target.name,
		rows: [],
		serves: [],
		reaped: 0,
		survivors: 0,
		killed: 0,
		dryRun: !opts.act,
		authorityReachable: true,
	};
	const listing = opts.exec(target, listScript(target));
	if (listing.code !== 0)
		return { ...base, authorityReachable: false, rows: [] };
	const { worktrees, ps } = parseHubGcListing(listing.out);
	let reachable = true;
	const guarded: ClaimStateFace = (item) => {
		try {
			return opts.claimState(item);
		} catch (e) {
			reachable = false;
			throw e;
		}
	};
	let serves: HubGcServe[] = [];
	try {
		serves = scopedServes(ps, target.repoRoot, guarded);
	} catch {
		reachable = false;
	}
	const rows: HubGcRow[] = [];
	for (const w of worktrees) {
		let terminal = false;
		try {
			terminal = claimTerminal(w.item, guarded);
		} catch {
			reachable = false;
		}
		const anc =
			terminal && opts.ancestry
				? opts.ancestry(target, w)
				: { merged: false, pushed: false };
		rows.push(
			classifyWorktree(w, {
				terminal,
				authorityReachable: reachable,
				merged: anc.merged,
				pushed: anc.pushed,
				act: opts.act,
			}),
		);
	}
	// any authority leg failing flips prior reapable rows back to scan-only
	const finalRows = reachable
		? rows
		: rows.map((r) =>
				r.action === "would-reap" || r.action === "reap"
					? unreachableRow(r)
					: r,
			);
	if (!reachable || !opts.act)
		return {
			...base,
			rows: finalRows,
			serves: reachable ? serves : [],
			authorityReachable: reachable,
		};
	const reapRows = finalRows
		.filter((r) => r.action === "reap")
		.map((r) => ({
			worktree: r.worktree,
			branch: r.branch,
			// merged branches delete (-d); pushed-only keep the local name —
			// origin holds the evidence, the tip name survives hub-side too
			merged: opts.ancestry
				? opts.ancestry(target, {
						item: r.item,
						worktree: r.worktree,
						branch: r.branch,
						clean: true,
					}).merged
				: false,
		}));
	opts.exec(target, reapScript(target, reapRows, serves));
	// re-list verify: vanished rows = reaped, the rest stay survivors
	const verify = opts.exec(target, listScript(target));
	if (verify.code !== 0)
		return {
			...base,
			rows: finalRows,
			serves,
			survivors: reapRows.length,
			killed: serves.length,
			authorityReachable: true,
		};
	const left = new Set(
		parseHubGcListing(verify.out).worktrees.map((w) => w.worktree),
	);
	for (const r of finalRows)
		if (r.action === "reap" && left.has(r.worktree)) r.action = "protected";
	const reaped = finalRows.filter((r) => r.action === "reap").length;
	return {
		...base,
		rows: finalRows,
		serves,
		reaped,
		survivors: reapRows.length - reaped,
		killed: serves.length,
		authorityReachable: true,
	};
}
