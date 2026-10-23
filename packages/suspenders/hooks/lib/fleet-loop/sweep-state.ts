// fleet-loop/sweep-state.ts — W1201 automation doctrine (source:
// claude.dev/blog/building-effective-agent-automations) as a shared kit for
// the fleet-loop sweeps and their runners. Three agent-owned stores, one
// notice channel, one pause channel:
//   cursor  — per-source bookmark (lastMs + stable runId). A sweep mines
//             [lastMs, now] instead of a fixed time window, so a late run
//             covers the gap and an early run never repeats. The cursor
//             advances ONLY after the run's output is confirmed written
//             (record-only-after-confirmation); before acting, the run
//             stamps a `maybe-ran` marker carrying the runId — if the
//             process dies mid-run the next run sees the marker, knows the
//             previous outcome is unclear, and re-mines from the last
//             confirmed cursor. Early runs repeat, gaps do not.
//             W1201.1: the maybe-ran evidence is a SEPARATE pending file
//             (<cursor>-pending.json) — a confirmed bookmark survives any
//             pending/crash, and the confirmed position is read BEFORE the
//             run acts.
//   notice  — bounded one-line-per-failed-source channel the W822 pulse
//             section reads (readSweepNotices). A failed source is never a
//             quiet skip: the notice names the task and the failure; the
//             sweep keeps running the remaining tasks.
//   pause   — per-task named stop-reason marker (budget pause, not crash):
//             a runner that hits its spend cap writes pause/<task>.json
//             {reason, at} instead of crashing hot; the sweep skips the
//             task, says why, and ops clears it by deleting the marker.
// Reader-owned conf is NOT stored here — config is re-read fresh every run
// from its own surface (env / notify.yaml / knowledge-sync.json).
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SweepCursorOk {
	state: "ok";
	lastMs: number;
	runId: string;
}
/** W1201.1: pending evidence lives in its OWN file (see markMaybeRan) — a
 *  single-file maybe-ran row carried no position, so one crash between the
 *  stamp and the confirm destroyed the last confirmed bookmark (B1). */
export interface SweepPending {
	state: "maybe-ran";
	runId: string;
	at: number;
}

/** SUSPENDERS_MAINTENANCE_STATE relocates the agent-state dir (tests/ops);
 *  default ~/.claude-insights/maintenance. */
export function sweepStateDir(): string {
	const override = process.env.SUSPENDERS_MAINTENANCE_STATE;
	if (override !== undefined && override.trim() !== "") return override.trim();
	return join(homedir(), ".claude-insights", "maintenance");
}

export const noticesPath = (dir = sweepStateDir()): string =>
	join(dir, "notices.jsonl");
export const pausePath = (name: string, dir = sweepStateDir()): string =>
	join(dir, "pause", `${name}.json`);
/** The pending-evidence file that pairs with a cursor path (W1201.1). */
export const pendingPath = (cursorPath: string): string =>
	`${cursorPath.replace(/\.json$/, "")}-pending.json`;

function writeJsonAtomic(path: string, value: unknown): boolean {
	try {
		mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

function readJson<T>(path: string): T | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

/** The last CONFIRMED cursor position; fallback when absent/unclear. */
export function confirmedMs(
	cursor: SweepCursorOk | null,
	fallbackMs: number,
): number {
	return cursor !== null && Number.isFinite(cursor.lastMs) && cursor.lastMs > 0
		? cursor.lastMs
		: fallbackMs;
}

/** The CONFIRMED bookmark only — null = none (fallback applies). Legacy
 *  single-file maybe-ran rows read as absent: pending evidence never
 *  carried a position (W1201.1). */
export function readCursor(path: string): SweepCursorOk | null {
	const c = readJson<SweepCursorOk>(path);
	if (c === null) return null;
	return c.state === "ok" &&
		Number.isFinite(c.lastMs) &&
		c.lastMs > 0 &&
		typeof c.runId === "string"
		? c
		: null;
}

/** The unclear-outcome evidence of an in-flight or crashed run, or null. */
export function readPending(cursorPath: string): SweepPending | null {
	const p = readJson<SweepPending>(pendingPath(cursorPath));
	return p !== null &&
		p.state === "maybe-ran" &&
		typeof p.runId === "string" &&
		typeof p.at === "number"
		? p
		: null;
}

/** Stamp BEFORE the run acts — in a SEPARATE pending file, so the
 *  confirmed bookmark stays durable across a pending/crash (B1). */
export function markMaybeRan(
	cursorPath: string,
	runId: string,
	nowMs = Date.now(),
): boolean {
	return writeJsonAtomic(pendingPath(cursorPath), {
		state: "maybe-ran",
		runId,
		at: nowMs,
	});
}

/** Advance ONLY on confirmed success (output written and verified); the
 *  run's pending evidence is cleared with the confirmation. */
export function confirmCursor(
	path: string,
	lastMs: number,
	runId: string,
): boolean {
	if (!writeJsonAtomic(path, { state: "ok", lastMs, runId })) return false;
	try {
		rmSync(pendingPath(path), { force: true });
	} catch {}
	return true;
}

// ---- failure notices (failed source != quiet skip) -------------------------

export const NOTICE_KEEP = 50;

/** One line per failed source; bounded ring, newest last. Returns the line. */
export function appendSweepNotice(
	task: string,
	line: string,
	dir = sweepStateDir(),
): string {
	const entry = `${new Date().toISOString()} ${task} ${line}`;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const prior = readSweepNotices(dir, Number.MAX_SAFE_INTEGER);
		const next = [...prior, entry].slice(-NOTICE_KEEP);
		writeFileSync(join(dir, "notices.jsonl"), `${next.join("\n")}\n`, {
			mode: 0o600,
		});
	} catch {}
	return entry;
}

/** Fresh failure notices for the pulse section (default: last 24h). */
export function readSweepNotices(
	dir = sweepStateDir(),
	maxAgeMs = 86_400_000,
): string[] {
	const out: string[] = [];
	try {
		const text = readFileSync(noticesPath(dir), "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const at = Date.parse(line.slice(0, "2026-10-23T00:00:00.000Z".length));
			if (Number.isFinite(at) && Date.now() - at > maxAgeMs) continue;
			out.push(line);
		}
	} catch {}
	return out;
}

// ---- budget pause with a named stop-reason (not crash) ---------------------

export interface SweepPause {
	reason: string;
	at: number;
}

export function readPause(
	name: string,
	dir = sweepStateDir(),
): SweepPause | null {
	const p = readJson<SweepPause>(pausePath(name, dir));
	if (p === null) return null;
	return typeof p.reason === "string" && typeof p.at === "number" ? p : null;
}

/** A runner budget-pauses itself with a named stop-reason; ops clears it. */
export function pauseTask(
	name: string,
	reason: string,
	dir = sweepStateDir(),
): boolean {
	return writeJsonAtomic(pausePath(name, dir), { reason, at: Date.now() });
}
