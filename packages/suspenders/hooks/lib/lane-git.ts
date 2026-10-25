// hooks/lib/lane-git.ts — W835 per-lane git observation (emdash lift):
// one budgeted probe pair per lane worktree answers "is this lane's branch
// merge-ready?" — branch, dirty, pending diffStats, gitignore-respecting
// untracked count, ahead/behind, conflicted count, headOid. Every field
// independently null-degrades so odd/old records still parse (per-record
// degradation, never a scan-wide failure — W663 doctrine); probes are
// time-memoized (10s TTL) so board payload renders and `work lanes` don't
// spawn git more than once per window per worktree.
import { existsSync } from "node:fs";

export interface LaneGitDiffStats {
	added: number;
	deleted: number;
}

export interface LaneGitObservation {
	branch: string | null;
	headOid: string | null;
	dirty: boolean | null;
	diffStats: LaneGitDiffStats | null;
	untracked: number | null;
	ahead: number | null;
	behind: number | null;
	conflicted: number | null;
	mergeReady: boolean | null;
}

// emdash byte budget — a probe whose output exceeds this degrades to null
// (per-record, never scan-wide).
const PROBE_MAX_BYTES = 32 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const MEMO_TTL_MS = 10_000;

const probeGit = (args: string[], cwd: string): string | null => {
	try {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: PROBE_MAX_BYTES,
		});
		return r.exitCode === 0 ? r.stdout.toString() : null;
	} catch {
		return null;
	}
};

// ONE source of truth for the merge-ready gate (also embedded in the board
// browser script): !dirty && ahead>0 && conflicted==0. Any unknown term
// (null) never invents a verdict — the gate reads null.
export function mergeReady(
	obs: Pick<LaneGitObservation, "dirty" | "ahead" | "conflicted">,
): boolean | null {
	const { dirty, ahead, conflicted } = obs;
	if (dirty === null || ahead === null || conflicted === null) return null;
	return !dirty && ahead > 0 && conflicted === 0;
}

// Why NOT merge-ready — human badge text; embedded in the board browser
// script (one implementation, server + client).
export function mergeReadyWhy(obs: {
	dirty: boolean | null;
	ahead: number | null;
	conflicted: number | null;
}): string[] {
	const why: string[] = [];
	if (obs.dirty === true) why.push("dirty");
	if (obs.conflicted != null && obs.conflicted > 0)
		why.push(`${obs.conflicted} conflicted`);
	if (obs.ahead != null && obs.ahead <= 0) why.push("not ahead");
	return why;
}

const shaLike = (s: string): boolean => /^[0-9a-f]{40,64}$/.test(s);

/** Porcelain-v2 header line → its observation field. Unknown shapes are
 *  skipped — that field alone stays null. */
function applyHeader(obs: LaneGitObservation, line: string): void {
	if (line.startsWith("# branch.oid ")) {
		const oid = line.slice("# branch.oid ".length).trim();
		obs.headOid = shaLike(oid) ? oid : null;
	} else if (line.startsWith("# branch.head ")) {
		const name = line.slice("# branch.head ".length).trim();
		obs.branch =
			name && name !== "(detached)" && name !== "(initial)" ? name : null;
	} else if (line.startsWith("# branch.ab ")) {
		const m = / \+(\d+) -(\d+)$/.exec(line);
		if (m) {
			obs.ahead = Number(m[1]);
			obs.behind = Number(m[2]);
		}
	}
}

/** Porcelain-v2 body → dirty/untracked/conflicted counts. `!` ignored
 *  entries never count as dirty terms; `1` changed, `2` renamed, `u`
 *  unmerged, `?` untracked. */
function parseStatusBody(obs: LaneGitObservation, status: string): void {
	let changed = 0;
	let untracked = 0;
	let conflicted = 0;
	for (const line of status.split("\n")) {
		if (line.startsWith("u ")) {
			conflicted++;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			changed++;
		} else if (line.startsWith("? ")) {
			untracked++;
		}
	}
	obs.dirty = changed + untracked > 0 || conflicted > 0;
	obs.untracked = untracked;
	obs.conflicted = conflicted;
}

/** `git diff HEAD --numstat` → summed pending added/deleted (staged +
 *  unstaged tracked changes vs HEAD; binary rows skip their column). */
function parseNumstat(numstat: string): LaneGitDiffStats {
	let added = 0;
	let deleted = 0;
	for (const line of numstat.split("\n")) {
		const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (!m) continue;
		if (m[1] !== "-") added += Number(m[1]);
		if (m[2] !== "-") deleted += Number(m[2]);
	}
	return { added, deleted };
}

// W1279: the merge gate's "ahead" counts commits the integration base
// (main) lacks — never upstream sync. branch.ab compares the push
// upstream, which reads +0 once the lane pushes (protocol step 4), so
// every pushed close read "not merge-ready: not ahead" (W1281, W1282,
// W1285). The upstream count stays as the fallback when no base ref
// resolves; `behind` keeps its upstream meaning (push sync).
function observeAhead(obs: LaneGitObservation, worktree: string): void {
	for (const base of ["main", "origin/main"]) {
		const out = probeGit(["rev-list", "--count", `${base}..HEAD`], worktree);
		if (out === null) continue;
		const n = Number(out.trim());
		if (Number.isFinite(n)) obs.ahead = n;
		return;
	}
}

/** The observation: one budgeted probe pair per worktree. */
function observe(worktree: string): LaneGitObservation {
	const obs: LaneGitObservation = {
		branch: null,
		headOid: null,
		dirty: null,
		diffStats: null,
		untracked: null,
		ahead: null,
		behind: null,
		conflicted: null,
		mergeReady: null,
	};
	if (!existsSync(worktree)) return obs;
	const status = probeGit(["status", "--porcelain=v2", "--branch"], worktree);
	const numstat = probeGit(["diff", "HEAD", "--numstat"], worktree);
	if (!status && !numstat) return obs; // not a repo / git missing — all null
	for (const line of (status ?? "").split("\n")) {
		if (line.startsWith("#")) applyHeader(obs, line);
	}
	if (status) parseStatusBody(obs, status);
	if (numstat !== null) obs.diffStats = parseNumstat(numstat);
	observeAhead(obs, worktree);
	obs.mergeReady = mergeReady(obs);
	return obs;
}

// 10s TTL memo — board payload renders every 5s must not re-spawn git.
const memo = new Map<string, { until: number; obs: LaneGitObservation }>();

/** One observation per worktree (memoized). */
export const gitObservation = (worktree: string): LaneGitObservation => {
	const hit = memo.get(worktree);
	if (hit && Date.now() < hit.until) return hit.obs;
	const obs = observe(worktree);
	memo.set(worktree, { until: Date.now() + MEMO_TTL_MS, obs });
	return obs;
};

/** Batched face (board payload, W663): unique worktrees, one memo window. */
export const gitObservations = (
	list: { sid: string; worktree: string }[],
): Map<string, LaneGitObservation> => {
	const out = new Map<string, LaneGitObservation>();
	for (const { worktree } of list) {
		if (out.has(worktree)) continue;
		out.set(worktree, gitObservation(worktree));
	}
	return out;
};

/** Tests only: drop the memo so fresh fixtures observe for real. */
export const resetLaneGitMemo = (): void => {
	memo.clear();
};

/** ` · merge-ready` / ` · not merge-ready (dirty, 1 conflicted)` / "" — text badge. */
export const gitBadge = (obs: LaneGitObservation | null): string => {
	if (!obs || obs.mergeReady == null) return "";
	const why = mergeReadyWhy(obs);
	return why.length
		? ` · not merge-ready (${why.join(", ")})`
		: " · merge-ready";
};
