// hooks/lib/session-bridge.ts — the ONE spawn-session-start/-end primitive
// every non-Claude dialect shares (W296, extracted from the W73 codex
// adapter when copilot needed the identical plumbing). W294 adds the
// session-row heartbeat: the shared stop gate touches hb every turn.
// Claude Code itself calls session-start.ts/session-end.ts directly as hook
// commands — no bridge needed, its payload already matches.
// Every OTHER harness (codex,
// own payload shape and resolves a sid by its own identity rules in its own
// lib/<dialect>.ts, then calls these three functions with the fields
// session-start.ts/session-end.ts actually read. Adding a new dialect never
// touches this file.
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { lanesFileFor } from "./fleetlane.ts";
import { openStore } from "./govdb.ts";

// Bun's spawnSync drops the `input` option — stdin rides a temp file (the
// gates.test.ts lesson, shared by every dialect that spawns session-*.ts).
const payloadFile = (json: string): string => {
	const f = `${tmpdir()}/gate-session-payload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	writeFileSync(f, json);
	return f;
};

// transcriptPathFor: synthesize a lane-log path when this cwd is a fleet
// worktree (lanes.json present) — the zombie sweep's transcript-liveness
// rule stays meaningful for non-claude transcripts too (lesson.zombie-
// session-hygiene). Empty string when there's no fleet lane file at all
// (an interactive, non-dispatched session — still registers, just with no
// transcript to watch for liveness).
export function transcriptPathFor(cwd: string, sid: string): string {
	const lanesFile = lanesFileFor(cwd);
	return lanesFile
		? `${lanesFile.slice(0, lanesFile.lastIndexOf("/"))}/lane-${sid}.log`
		: "";
}

export type SessionStartPayload = {
	session_id: string;
	transcript_path: string;
	source: string;
};

// spawnSessionStart: runs session-start.ts with the given payload, returns
// its stdout (the bootstrap packet) trimmed — "" when the script produced
// nothing (e.g. a falsy session_id made it exit before registering).
export function spawnSessionStart(payload: SessionStartPayload): string {
	const pf = payloadFile(JSON.stringify(payload));
	const proc = Bun.spawnSync(
		[process.execPath, `${import.meta.dir}/../session-start.ts`],
		{ stdin: Bun.file(pf), stdout: "pipe", stderr: "pipe" },
	);
	rmSync(pf, { force: true });
	return new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
}

// spawnSessionEnd: runs session-end.ts (CLOSED + settle) — fire-and-forget,
// no dialect consumes its output today.
export function spawnSessionEnd(sessionId: string): void {
	const pf = payloadFile(JSON.stringify({ session_id: sessionId }));
	Bun.spawnSync([process.execPath, `${import.meta.dir}/../session-end.ts`], {
		stdin: Bun.file(pf),
		stdout: "ignore",
		stderr: "ignore",
	});
	rmSync(pf, { force: true });
}

// touchSessionHeartbeat (W294): the plane's hb refresh — Stop fires every
// turn for every dialect (claude `gate.ts stop`, codex/copilot/grok/cline
// stop modes), so the shared stop gate doubles as the liveness heartbeat
// and live copilot/codex orchestrators stop getting swept CLOSED at the
// 20-min hb-stale window (govdb sweepStaleSessions). Fills an empty
// transcript_path (manual copilot/codex sessions carry the real transcript
// only on the Stop payload), never clobbers one, never resurrects CLOSED.
// Fail-open: liveness accounting never gates a turn end.
export function touchSessionHeartbeat(
	sid: string,
	transcriptPath?: string,
): void {
	if (!sid) return;
	try {
		const store = openStore();
		store.run(
			"UPDATE sessions SET hb = ?, " +
				"transcript_path = COALESCE(NULLIF(transcript_path, ''), ?) " +
				"WHERE sid = ? AND state = 'RUNNING'",
			Date.now(),
			transcriptPath || null,
			sid,
		);
		store.close();
	} catch {
		// fail-open: a dead store never blocks a stop
	}
}
