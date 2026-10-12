// hooks/lib/session-state.ts — atomic per-session state IO for the advisory
// counters (gate streaks, nudge cooldown, tool-failure counter). Files live
// in $TMPDIR keyed `claude-<scope>-<sid>.json`, written 0600 via tmp+rename
// so concurrent hook processes never interleave halves (claudecode research
// §1.6). Advisory law: readers get null and writers get false on ANY
// failure — a state problem never changes a gate verdict, it only loses
// the throttle.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sessionStatePath(scope: string, sid: string): string {
	return `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/claude-${scope}-${sid}.json`;
}

export function readSessionState<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export function writeSessionState(path: string, value: unknown): boolean {
	try {
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}
