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
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";

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

const HARNESS_NAMES = ["claude", "codex", "copilot", "cline", "grok"];
/** Compatibility expression: command position only, never a prompt path. */
export const HARNESS_ARG_RE =
	/^\s*(?:\d+\s+)?(?:\S*\/)?(?:claude|codex|copilot|cline|grok)(?:\s|$)/i;
type ExecutableCache = { key: string; until: number; paths: Set<string> };
let executableCache: ExecutableCache | undefined;
const pathCache = new Map<string, { until: number; path: string | null }>();
function resolvedExecutable(path: string): string | null {
	const cached = pathCache.get(path);
	if (cached && cached.until > Date.now()) return cached.path;
	let resolved: string | null = null;
	try {
		resolved = realpathSync(path);
	} catch {}
	if (pathCache.size >= 32) pathCache.clear();
	pathCache.set(path, { until: Date.now() + 10_000, path: resolved });
	return resolved;
}

function canonicalExecutable(
	token: string,
	canonical: ReadonlySet<string>,
): boolean {
	if (canonical.has(token)) return true;
	const resolved = resolvedExecutable(token);
	return resolved !== null && canonical.has(resolved);
}

/** At most five resolved install paths; refresh upgrades without per-row filesystem probes. */
function harnessExecutables(): Set<string> {
	const key = `${process.env.PATH ?? ""}\0${process.env.HOME ?? ""}`;
	if (executableCache?.key === key && executableCache.until > Date.now())
		return executableCache.paths;
	const paths = new Set<string>();
	for (const name of HARNESS_NAMES) {
		try {
			const executable = Bun.which(name, { PATH: process.env.PATH });
			if (executable) paths.add(realpathSync(executable));
		} catch {}
	}
	executableCache = { key, until: Date.now() + 10_000, paths };
	return paths;
}

function commandToken(args: string): { token: string; rest: string } | null {
	const match = args.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/);
	if (!match) return null;
	return {
		token: match[1] ?? match[2] ?? match[3],
		rest: args.slice(match[0].length),
	};
}

/** Recognize the executable, or a Node/Bun script entrypoint, never later arguments. */
export function isHarnessProcess(
	row: string,
	canonical: ReadonlySet<string> = harnessExecutables(),
): boolean | null {
	const args = row.replace(/^\s*\d+\s+/, "").trimStart();
	// Native install paths may contain spaces that ps does not quote.
	if (
		[...canonical].some((path) => args === path || args.startsWith(`${path} `))
	)
		return true;
	const command = commandToken(args);
	if (!command) return false;
	if (HARNESS_NAMES.includes(basename(command.token))) return true;
	if (canonicalExecutable(command.token, canonical)) return true;
	if (/\/claude\/versions\/[^/]+$/.test(command.token)) return null;
	if (!/^(?:node|nodejs|bun)$/.test(basename(command.token))) return false;
	const entrypoint = commandToken(command.rest);
	if (!entrypoint || entrypoint.token.startsWith("-")) return false;
	if (
		HARNESS_NAMES.includes(basename(entrypoint.token)) ||
		canonicalExecutable(entrypoint.token, canonical)
	)
		return true;
	if (
		/\/node_modules\/@(?:anthropic-ai\/claude-code|openai\/codex|github\/copilot)\//.test(
			entrypoint.token,
		)
	)
		return null;
	return false;
}

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
		return referencesSid.test(args) ? isHarnessProcess(args) : false;
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
		.filter((l) => isHarnessProcess(l))
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
