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
import {
	type Dirent,
	existsSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
// W422: harness names come from the executor-adapter registry (shared
// surface for hooks + scripts trees; adapters are runtime-independent data).
import { HARNESS_PROCESS_NAMES } from "./executors/registry.ts";

export type LaneRef = {
	sid: string;
	item: string;
	pid?: number;
	worktree?: string;
	host?: string;
	launchedAt?: number;
};

// claimant transcript freshness — the same liveness `work reclaim` trusts
// (15-min mtime floor over ~/.claude/projects/**/*<sid>*.jsonl). W466
// bounding: the old `**` recursive glob walked EVERY project transcript on
// every probe (per lane, per `work lanes`/fleet render). The known layout
// is ≤4 levels (main: <proj>/<sid>.jsonl; subagents:
// <proj>/<parent>/subagents/agent-<id>.jsonl) — so the scan is a
// depth-capped readdir walk (≤4, ≤50k files) with early exit. Positive
// results memoize for 10s, re-validated by one stat before reuse;
// negatives always rescan — a fresh transcript must be immediately
// observable to the reclaim lease.
const transcriptMemo = new Map<string, string>(); // sid → fresh path, positive only
export const transcriptPath = (sid: string): string | null => {
	const floor = Date.now() - 15 * 60_000;
	const hit = transcriptMemo.get(sid);
	if (hit) {
		try {
			if (statSync(hit).mtimeMs > floor) return hit;
		} catch {}
		transcriptMemo.delete(sid); // stale memo entry — rescan
	}
	let found: string | null = null;
	const stack: [string, number][] = [];
	try {
		const root = `${process.env.HOME}/.claude/projects`;
		let budget = 50_000; // file+dir entries the walk may touch
		stack.push([root, 0]);
		while (stack.length > 0 && !found && budget > 0) {
			const [dir, depth] = stack.pop() as [string, number];
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				if (budget-- <= 0) break;
				const p = `${dir}/${e.name}`;
				if (e.isDirectory()) {
					if (depth < 4) stack.push([p, depth + 1]);
					continue;
				}
				if (!e.name.endsWith(".jsonl") || !e.name.includes(sid)) continue;
				try {
					if (statSync(p).mtimeMs > floor) {
						found = p;
						break;
					}
				} catch {}
			}
		}
	} catch {}
	if (found) {
		transcriptMemo.set(sid, found);
		if (transcriptMemo.size >= 64) {
			const oldest = transcriptMemo.keys().next().value;
			if (oldest !== undefined) transcriptMemo.delete(oldest);
		}
	}
	return found;
};

export const transcriptAlive = (sid: string): boolean =>
	transcriptPath(sid) !== null;

// W422: the harness roster is ADAPTER registry data now (a new agent lands
// in liveness by adding its adapter file + registry row — never an edit
// here). HARNESS_ARG_RE builds from the union so both stay in lockstep.
const HARNESS_NAMES = HARNESS_PROCESS_NAMES;
/** Compatibility expression: command position only, never a prompt path. */
export const HARNESS_ARG_RE = new RegExp(
	`^\\s*(?:\\d+\\s+)?(?:\\S*\\/)?(?:${HARNESS_NAMES.join("|")})(?:\\s|$)`,
	"i",
);
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

const escapePattern = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function legacyLaneReference(args: string, lane: LaneRef): boolean {
	const sid = escapePattern(lane.sid);
	const filename = `(?:brief-${sid}\\.md|lane-settings-${sid}\\.json)`;
	const worktree = lane.worktree ? resolve(lane.worktree) : null;
	const root =
		worktree &&
		basename(dirname(worktree)) === ".worktrees" &&
		basename(worktree) === lane.item
			? dirname(dirname(worktree))
			: null;
	const reference = root
		? `(^|[\\s"'(:=])${escapePattern(root)}/\\.fleet/${filename}`
		: `(^|[/\\s"'(:=])${filename}`;
	return new RegExp(`${reference}($|[\\s"'),:])`).test(args);
}

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
		const harness = isHarnessProcess(args);
		if (harness === false) return false;
		const sid = escapePattern(lane.sid);
		const referencesSid = new RegExp(
			`(^|[^A-Za-z0-9_-])${sid}([^A-Za-z0-9_-]|$)`,
		);
		if (referencesSid.test(args)) return harness;
		// ps flattens argv: an exact old brief/settings path can be prompt text.
		// Retain that ambiguity without blessing it or launching a duplicate.
		return legacyLaneReference(args, lane) ? null : false;
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
	// W123 prefix discipline (ported W395): exact-or-subdir only —
	// `.worktrees/W12` must not match a W123 lane's cwd; a cwd in a SUBDIR
	// of the tree still counts.
	return listing.split("\n").some((line) => {
		if (!line.startsWith("n")) return false;
		const cwd = line.slice(1);
		return cwd === wt || cwd.startsWith(`${wt}/`);
	});
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

// W610 reclaim parity — the tri-state verdict. laneAlive collapses unknown
// into dead; a bulk reaper may only release on POSITIVE death evidence
// (monitor doctrine W51: lookup failure is never death), so reclaim-all
// needs the honest third answer. Foreign-host lanes carry no process-table
// trust — transcript is their only liveness term, and without it they read
// unknown, never dead.
export type LaneVerdict = "alive" | "dead" | "unknown";
export const laneVerdict = (l: LaneRef): LaneVerdict => {
	if (l.host !== undefined && l.host !== THIS_HOST)
		return transcriptAlive(l.sid) ? "alive" : "unknown";
	const identity = laneProcessIdentity(l);
	if (identity === true || transcriptAlive(l.sid)) return "alive";
	if (identity === false) return "dead";
	return "unknown";
};
