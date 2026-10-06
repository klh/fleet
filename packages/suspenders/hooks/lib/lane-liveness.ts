// lane-liveness.ts — THE lane-liveness surface (2026-10-05).
// Three consumers, one truth: `work lanes` (human + --json), dispatch-next
// pool counting, fleet-loop retire guards. Replaces the ps|grep folk-magic
// whose two leaks clogged the dispatch pool with ghosts: recycled pids read
// as live lanes (kill(pid,0) passes for a random process), and the host
// field made remote/codex lanes permanently "live" with no expiry.
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
const processReferencesSid = (pid: number, sid: string): boolean => {
	if (!pid) return false;
	return psArgs().some(
		(l) =>
			l.trim().startsWith(`${pid} `) &&
			HARNESS_ARG_RE.test(l) &&
			l.includes(sid),
	);
};

const worktreeLive = (wt?: string): boolean => {
	if (!wt || !existsSync(wt)) return false;
	const listing = Bun.spawnSync([
		"lsof",
		"-a",
		"-p",
		psArgs()
			.filter((l) => HARNESS_ARG_RE.test(l))
			.map((l) => l.trim().split(/\s+/)[0])
			.join(","),
		"-d",
		"cwd",
		"-Fn",
	]).stdout.toString();
	return listing
		.split("\n")
		.some((line) => line.startsWith("n") && line.slice(1).startsWith(wt));
};

// the verdict dispatch-next/fleet-loop/`work lanes` all share. `host` is
// stamped on EVERY dispatch entry (hostname()), so it means nothing by
// itself — only a FOREIGN host carries no process-table trust; those lanes
// live on claimant-transcript freshness alone
import { hostname } from "node:os";
const THIS_HOST = hostname();
export const laneAlive = (l: LaneRef): boolean =>
	l.host !== undefined && l.host !== THIS_HOST
		? transcriptAlive(l.sid)
		: processReferencesSid(l.pid ?? 0, l.sid) || worktreeLive(l.worktree);
