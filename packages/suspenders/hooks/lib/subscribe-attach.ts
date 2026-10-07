// hooks/lib/subscribe-attach.ts — W417.1: spawn-level WS-inbox attach.
// The W303 coord subscribe (persistent WebSocket push — never polls) used
// to be opened only by session-start.ts, so headless codex/copilot lanes
// without Claude hooks never got one, and a lane's earliest events landed
// before any SessionStart could open the socket. The attach recipe is
// shared by session-start (session level) and spawnClaude (spawn level,
// sid known at dispatch) so every lane has a push inbox from birth.
// Idempotent per sid: an anchored pgrep detects a live subscribe for the
// sid and leaves it alone — re-attach is a no-op.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// coord CLI ships in bin/ next to this lib (repo checkout and installed
// prefix share the layout); fall back to the pre-namespacing ~/.claude/bin
// location for old installs.
export const coordCliPath = (): string => {
	for (const p of [
		join(import.meta.dir, "..", "bin", "coord.ts"),
		`${process.env.HOME}/.claude/bin/coord.ts`,
	])
		if (existsSync(p)) return p;
	return `${process.env.HOME}/.claude/bin/coord.ts`;
};

export const coordSubscribeLog = (sid: string): string =>
	`${process.env.HOME}/.claude-insights/coord-subscribe-${sid}.log`;

// Claude Code subagents share the parent's session_id; session-start
// registers (and attaches their subscribe under) `<sid>#<agent>` — the lane
// id every subscribe-log consumer must derive the same way. Shared by
// session-start and the W417.4 push gate.
export const subagentLaneSuffix = (transcriptPath: string): string => {
	const m = transcriptPath.match(/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/);
	return m ? `#${m[1]}` : "";
};

// anchored on the exact `--as <sid>` tail — at most one live subscribe per
// sid; the W494 staleness exit keeps dead sessions' subscribes from
// haunting the process table, after which a re-attach is allowed again.
export const subscribeLive = (sid: string): boolean =>
	Bun.spawnSync([
		"/usr/bin/pgrep",
		"-f",
		`coord[.]ts subscribe --as ${sid}$`,
	]).exitCode === 0;

// Returns true when a NEW subscribe was spawned; false when one was
// already live (or no coord CLI resolves — the caller surfaces that).
export const attachSubscribe = (
	sid: string,
	opts: { coord?: string } = {},
): boolean => {
	if (subscribeLive(sid)) return false;
	const coord = opts.coord ?? coordCliPath();
	if (!existsSync(coord)) return false;
	const log = coordSubscribeLog(sid);
	mkdirSync(dirname(log), { recursive: true });
	Bun.spawn(
		[
			"/bin/sh",
			"-c",
			`nohup bun ${coord} subscribe --as ${sid} >> ${log} 2>&1 &`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	).unref();
	return true;
};

// W418: the lifecycle twin of attach — anchored pkill for the sid's
// subscribe. Session end, a final work-done, and the coord gc sweep land
// here instead of waiting out the W494 15-min staleness exit.
export const reapSubscribe = (sid: string): boolean => {
	if (!subscribeLive(sid)) return false;
	Bun.spawnSync(["/usr/bin/pkill", "-f", `coord[.]ts subscribe --as ${sid}$`]);
	return true;
};

// gc sweep: ONE pgrep pass lists every live subscribe; sids the predicate
// calls dead get reaped. Returns the reaped sids. The caller owns the
// deadness verdict (session CLOSED / not live) — this file stays DB-free.
export const reapDeadSubscribes = (
	sid_dead: (sid: string) => boolean,
): string[] => {
	const p = Bun.spawnSync([
		"/usr/bin/pgrep",
		"-fl",
		"coord[.]ts subscribe --as ",
	]);
	if (p.exitCode !== 0) return [];
	const reaped: string[] = [];
	for (const line of new TextDecoder()
		.decode(p.stdout ?? new Uint8Array())
		.split("\n")) {
		const m = / --as (\S+)/.exec(line);
		if (!m || !sid_dead(m[1])) continue;
		if (reapSubscribe(m[1])) reaped.push(m[1]);
	}
	return reaped;
};

// W418 reap-on-idle: when a work item closes (done) or is given back
// (release) and its owner holds no other unfinished item, the lane's WS
// subscribe has nothing left to push to — reap it. The store comes in as a
// parameter so this lifecycle file stays DB-free; the SQL mirrors
// releaseWorkClaim's unfinished set (CLAIMED/RUNNING/ORPHANED).
type Storeish = {
	query: (sql: string) => { get: (...params: unknown[]) => unknown };
};
export const reapIfIdle = (store: Storeish, sid: string): boolean => {
	if (!sid) return false;
	const busy = store.query(
		"SELECT 1 FROM work_items WHERE owner_sid = ? AND state IN ('CLAIMED','RUNNING','ORPHANED') LIMIT 1",
	).get(sid);
	if (busy) return false;
	return reapSubscribe(sid);
};
