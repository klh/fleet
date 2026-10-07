// lane-liveness.ts — THE lane-liveness surface (2026-10-05; W494.1 law
// 2026-10-07). Three consumers, one truth: `work lanes` (human + --json),
// dispatch-next pool counting, fleet-loop retire guards. Replaces the
// ps|grep folk-magic whose leaks clogged the dispatch pool with ghosts:
// recycled pids (kill(pid,0) passes for a random process), permanently-
// trusted host lanes, and worktree cwd — W494.1: a cwd is a location, not
// a heartbeat, so it is EVIDENCE for sweeps (worktreeLive), never a
// liveness term. Verdict: live = recorded pid alive AND anchored harness
// args referencing the sid, or — pid gone — the claimant transcript fresh
// inside the 15-min reclaim lease; stale = pid gone + heartbeat stale.
import { existsSync, statSync } from "node:fs";

export type LaneRef = {
	sid: string;
	item: string;
	pid?: number;
	worktree?: string;
	host?: string;
	launchedAt?: number;
};

// claimant transcript freshness — the same liveness `work reclaim` trusts
// (15-min mtime floor over ~/.claude/projects/**/*<sid>*.jsonl). Path-valued
// primitive; work.ts's session settle keeps storing the path.
export const transcriptPath = (sid: string): string | null => {
	const floor = Date.now() - 15 * 60_000;
	try {
		const glob = new Bun.Glob(`**/*${sid}*.jsonl`);
		for (const rel of glob.scanSync({
			cwd: `${process.env.HOME}/.claude/projects`,
			onlyFiles: true,
		})) {
			const f = `${process.env.HOME}/.claude/projects/${rel}`;
			try {
				if (existsSync(f) && statSync(f).mtimeMs > floor) return f;
			} catch {}
		}
	} catch {}
	return null;
};

export const transcriptAlive = (sid: string): boolean =>
	transcriptPath(sid) !== null;

/** A lane harness appears in ps args as its own command word: line-start
 *  or a path segment, followed by space/end. An UNANCHORED match turned
 *  every args line containing ".claude/..." into a "lane harness" — 19
 *  orphaned coord-subscribe phantoms kept dead rows live forever
 *  (2026-10-06 ghost anatomy). */
export const HARNESS_ARG_RE = /(^|\/)(claude|codex|copilot|cline|grok)(\s|$)/i;

const psArgs = (): string[] =>
	Bun.spawnSync(["ps", "-axo", "pid=,args="])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);

// a lane is live when its process still references its own brief/sid —
// a recycled pid runs an unrelated command and reads dead (args=, not
// comm=: macOS truncates comm= at 15 chars, which hid copilot lanes — W309)
export type ProcessInspection = { exitCode: number | null; stdout: string };
export type ProcessInspector = () => ProcessInspection;
const inspectProcesses: ProcessInspector = () => {
	const result = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
};

/** True = this lane's harness; false = observed absent/reused PID; null = unknown.
 * Unknown never authorizes another spawn or filesystem retirement. */
export function laneProcessIdentity(
	lane: LaneRef,
	inspect: ProcessInspector = inspectProcesses,
): boolean | null {
	if (lane.host !== undefined && lane.host !== THIS_HOST) return null;
	if (!lane.pid) return false;
	if (!Number.isSafeInteger(lane.pid) || lane.pid < 0 || !lane.sid) return null;
	try {
		const result = inspect();
		if (result.exitCode !== 0 || !result.stdout.trim()) return null;
		const rows = result.stdout.trim().split("\n");
		if (rows.some((row) => !/^\s*\d+\s+\S/.test(row))) return null;
		const row = rows.find(
			(row) => Number.parseInt(row.trim(), 10) === lane.pid,
		);
		if (!row) return false;
		const args = row.replace(/^\s*\d+\s+/, "");
		const sid = lane.sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const referencesSid = new RegExp(
			`(^|[^A-Za-z0-9_-])${sid}([^A-Za-z0-9_-]|$)`,
		);
		return HARNESS_ARG_RE.test(args) && referencesSid.test(args);
	} catch {
		return null;
	}
}

/** Evidence probe for the sweep surfaces (dispatch-next prune, fleet-loop
 *  retire guard): a live harness process with cwd inside the worktree.
 *  W494.1: NEVER a liveness term — a cwd is a location, not a heartbeat.
 *  args= roster (W309 comm= truncation), anchored match (W494 phantom). */
export const worktreeLive = (wt?: string): boolean => {
	if (!wt || !existsSync(wt)) return false;
	const pids = psArgs()
		.filter((l) => HARNESS_ARG_RE.test(l))
		.map((l) => l.trim().split(/\s+/)[0]);
	if (pids.length === 0) return false;
	const listing = Bun.spawnSync([
		"lsof",
		"-a",
		"-p",
		pids.join(","),
		"-d",
		"cwd",
		"-Fn",
	]).stdout.toString();
	return listing
		.split("\n")
		.some((line) => line.startsWith("n") && line.slice(1).startsWith(wt));
};

// the verdict dispatch-next/fleet-loop/`work lanes` all share (W494.1):
// live = recorded pid alive AND anchored harness args referencing the sid,
// or — pid gone — the claimant transcript fresh inside the 15-min reclaim
// lease (the same heartbeat `work reclaim` trusts). pid gone + heartbeat
// stale = stale; the worktree cwd never rescues a dead lease. `host` is
// stamped on EVERY dispatch entry (hostname()), so it means nothing by
// itself — only a FOREIGN host carries no process-table trust; those lanes
// live on claimant-transcript freshness alone
import { hostname } from "node:os";
const THIS_HOST = hostname();
export const laneAlive = (l: LaneRef): boolean =>
	l.host !== undefined && l.host !== THIS_HOST
		? transcriptAlive(l.sid)
		: laneProcessIdentity(l) === true || transcriptAlive(l.sid);
