// W2952 — detached maintenance execution: a long maintenance task (coord-
// worker 600s, hub-update 1200s) can never fit a 120s-cycle maintenance
// slice, so inline admission with a full-timeout gate would defer it
// forever. Instead the sweep launches oversized tasks DETACHED — the cycle
// returns to merges immediately, and a cross-cycle supervisor enforces the
// task's own timeoutMs via a marker lease: {task, pid, ps lstart, deadline}.
//
// Identity is pid + `ps -o lstart=`: PID reuse changes lstart, so a
// recycled pid is never mistaken for the task. Missing lstart = unverifiable
// identity → stale, never killed. The marker is written atomically (tmp +
// rename) AFTER a successful spawn; if the marker write fails the just-
// spawned child is killed on its verified pid before surfacing the failure
// (review #120487: an untracked child could run next to a retry duplicate).
// Completion/timeout land in a bounded NDJSON receipt per task; SIGTERM at
// deadline, SIGKILL after the kill grace.
import {
	appendFileSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DetachedMarker {
	task: string;
	pid: number;
	/** ps lstart string captured post-spawn; "" = unverifiable */
	lstart: string;
	startedAt: number;
	deadlineMs: number;
	argv0: string;
	/** stamped when the deadline SIGTERM fired; SIGKILL rides its grace */
	signaledAt?: number;
}

export type DetachedOutcome =
	| "launched"
	| "running"
	| "timeout"
	| "killed"
	| "exited"
	| "stale"
	| "launch-failed";

export interface DetachedLaunchResult {
	outcome: DetachedOutcome;
	/** duration of the run the receipt records (0 when none) */
	ms: number;
}

const detachDir = (): string => {
	const override = process.env.SUSPENDERS_MAINT_DETACH_DIR;
	if (override !== undefined && override.trim() !== "") return override;
	return join(homedir(), ".claude-insights");
};

export const detachedMarkerPath = (task: string): string =>
	join(detachDir(), `maintenance-detached-${task}.json`);

/** atomic tmp+rename marker write; throws so the caller can reap the child */
const writeMarker = (m: DetachedMarker): void => {
	const path = detachedMarkerPath(m.task);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(m, null, "\t")}\n`);
	renameSync(tmp, path);
};

/** process identity probe: alive AND ps lstart matches the marker */
const identityAlive = (
	pid: number,
	lstart: string,
): { alive: boolean; lstart: string } => {
	if (pid <= 0) return { alive: false, lstart: "" };
	const p = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "lstart="]);
	if (p.exitCode !== 0) return { alive: false, lstart: "" };
	const cur = new TextDecoder().decode(p.stdout).trim();
	// missing/blank lstart = unverifiable identity — never treat as a match
	if (cur === "") return { alive: false, lstart: "" };
	return { alive: cur === lstart && lstart !== "", lstart: cur };
};

const readMarker = (task: string): DetachedMarker | null => {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(detachedMarkerPath(task), "utf8"),
		);
		if (typeof parsed !== "object" || parsed === null) return null;
		const m = parsed as Partial<DetachedMarker>;
		if (
			typeof m.pid !== "number" ||
			typeof m.lstart !== "string" ||
			typeof m.deadlineMs !== "number"
		)
			return null;
		return m as DetachedMarker;
	} catch {
		return null;
	}
};

const appendReceipt = (
	task: string,
	r: { outcome: DetachedOutcome; startedAt: number; ms: number; why: string },
): void => {
	const path = join(detachDir(), "maintenance-detached-receipts.ndjson");
	try {
		appendFileSync(path, `${JSON.stringify({ task, ...r })}\n`);
	} catch {}
};

/** SIGKILL grace after SIGTERM at the deadline */
const KILL_GRACE_MS = 5_000;

export interface DetachedState {
	outcome: DetachedOutcome;
	marker: DetachedMarker | null;
}

// the cross-cycle supervisor: inspect one task's lease and reap it when due.
// Never signals an unverified identity — a missing/blank lstart marker is
// stale (review #120427), a pid with a different lstart is a REUSED pid and
// the marker is stale, never killed.
export function detachedState(task: string, nowMs: number): DetachedState {
	const m = readMarker(task);
	if (m === null) return { outcome: "stale", marker: null };
	const id = identityAlive(m.pid, m.lstart);
	if (!id.alive) {
		rmSync(detachedMarkerPath(task), { force: true });
		appendReceipt(task, {
			outcome: "exited",
			startedAt: m.startedAt,
			ms: Math.max(0, nowMs - m.startedAt),
			why: `identity gone (ps lstart=${id.lstart || "none"})`,
		});
		return { outcome: "exited", marker: null };
	}
	if (nowMs < m.deadlineMs) return { outcome: "running", marker: m };
	if (m.signaledAt === undefined) {
		try {
			process.kill(m.pid, "SIGTERM");
		} catch {}
		writeMarker({ ...m, signaledAt: nowMs });
		return { outcome: "timeout", marker: m };
	}
	if (nowMs >= m.signaledAt + KILL_GRACE_MS) {
		try {
			process.kill(m.pid, "SIGKILL");
		} catch {}
		rmSync(detachedMarkerPath(task), { force: true });
		appendReceipt(task, {
			outcome: "killed",
			startedAt: m.startedAt,
			ms: Math.max(0, nowMs - m.startedAt),
			why: "deadline exceeded",
		});
		return { outcome: "killed", marker: null };
	}
	return { outcome: "timeout", marker: m };
}

export interface DetachedLaunchOpts {
	cmd: string[];
	cwd?: string;
	/** the task's own hard timeout — the marker deadline */
	timeoutMs: number;
	now?: () => number;
	/** injectable spawn for tests (failure injection) */
	spawn?: (cmd: string[], opts: { cwd?: string }) => { pid: number };
	/** injectable marker write — throw to prove child reaping */
	writeMarkerFn?: (m: DetachedMarker) => void;
}

// launch one oversized maintenance task detached: spawn first, capture the
// child's ps lstart, THEN write the atomic marker. A marker-write failure
// kills the just-spawned child on its verified pid and rethrows — an
// untracked child must never survive next to a retry duplicate (#120487).
export function launchDetached(
	task: string,
	opts: DetachedLaunchOpts,
): Promise<DetachedLaunchResult> {
	const now = opts.now ?? (() => Date.now());
	const startedAt = now();
	let child: { pid: number } | null = null;
	try {
		child = opts.spawn
			? opts.spawn(opts.cmd, { cwd: opts.cwd })
			: Bun.spawn(opts.cmd, {
					cwd: opts.cwd,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
		const lstart = captureLstart(child.pid);
		const marker: DetachedMarker = {
			task,
			pid: child.pid,
			lstart,
			startedAt,
			deadlineMs: startedAt + opts.timeoutMs,
			argv0: opts.cmd[0] ?? "",
		};
		const write = opts.writeMarkerFn ?? writeMarker;
		write(marker);
		return { outcome: "launched", ms: 0 };
	} catch (e) {
		if (child !== null) {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {}
		}
		const msg = e instanceof Error ? e.message : String(e);
		appendReceipt(task, {
			outcome: "launch-failed",
			startedAt,
			ms: 0,
			why: msg,
		});
		return { outcome: "launch-failed", ms: 0 };
	}
}

const captureLstart = (pid: number): string => identityAlive(pid, "").lstart;
