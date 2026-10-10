// hooks/gates/push.ts — W417.4: the claude-code push surface of the WS-first
// inbox (parent W417). The lane's coord subscribe (W303, attached at
// spawn/session level by W417.1) appends every pushed event line to
// coord-subscribe-<sid>.log; this gate tails the NEW lines into context on
// every tool call, so a working lane sees consults and decisions without
// polling the plane. Offset per lane: a byte offset in per-session state
// (claude-subtail-<sid>.json) tracks what was already delivered; only
// complete lines are consumed (a concurrently half-written tail line waits
// for its \n), truncation resets, and a burst holds beyond SHOW_LINES for
// the next fire — advance past SHOWN only, the cmdWait cursor precedent.
// Silent when nothing new. Advisory law: any failure stays silent (allow),
// it never blocks the tool that just ran.
import { existsSync, fstatSync, openSync, readSync, closeSync } from "node:fs";
import { allow, context, type HookInput } from "../lib/hookio.ts";
import {
	coordSubscribeLog,
	subagentLaneSuffix,
} from "../lib/subscribe-attach.ts";
import { resolveFleetLane } from "../lib/fleetlane.ts";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "../lib/session-state.ts";

// caps: 40 lines per fire, 256KB max read per fire — a burst holds, it
// never floods context
export const SHOW_LINES = 40;
const MAX_READ = 256 * 1024;
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

export type TailResult = { text: string; newOffset: number };

// new log lines since a byte offset, complete lines only, rendered as one
// context block ("" when nothing new). Exported for the unit leg; the gate
// wraps it with per-lane offset state.
export function tailSubscribeLog(logPath: string, offset: number): TailResult {
	let fh: number;
	try {
		fh = openSync(logPath, "r");
	} catch {
		return { text: "", newOffset: offset }; // no log yet (or reaped): stay put
	}
	try {
		const size = fstatSync(fh).size;
		let off = offset;
		if (size < off) off = 0; // truncated/rotated log: start over
		if (size === off) return { text: "", newOffset: off };
		const len = Math.min(size - off, MAX_READ);
		const buf = Buffer.alloc(len);
		const n = readSync(fh, buf, 0, len, off);
		const chunk = buf.toString("utf8", 0, n);
		const cut = chunk.lastIndexOf("\n");
		if (cut < 0) return { text: "", newOffset: off }; // no complete line yet
		const lines = chunk.slice(0, cut).split("\n");
		// FIFO: show the OLDEST unread lines, hold the burst remainder for
		// the next fire — advance past SHOWN only (cmdWait cursor precedent)
		const shownN = Math.min(lines.length, SHOW_LINES);
		const shown = lines
			.slice(0, shownN)
			.map((l) => l.replace(ANSI, "").trimEnd())
			.filter(Boolean);
		let newOffset = off;
		for (let i = 0; i < shownN; i++) newOffset += lines[i].length + 1;
		const held = lines.length - shownN;
		if (!shown.length) return { text: "", newOffset }; // whitespace only
		return {
			text: `WS INBOX +${shown.length}${held ? ` (+${held} held)` : ""}:\n${shown.map((l) => `  ${l}`).join("\n")}`,
			newOffset,
		};
	} catch {
		return { text: "", newOffset: offset }; // advisory: never block on read failure
	} finally {
		closeSync(fh);
	}
}

// lane id = the sid the subscribe was attached under: SUSPENDERS_SID env
// (dispatch sets it) → ppid-walk into lanes.json (codex/copilot lanes) →
// session_id (+ #subagent suffix — the session-start lane id).
function laneIdFor(hook: HookInput): string {
	const env = process.env.SUSPENDERS_SID;
	if (env) return env;
	const lane = resolveFleetLane(hook.cwd ?? process.cwd());
	if (lane) return lane.sid;
	const sid = hook.session_id;
	if (!sid) return "";
	return `${sid}${subagentLaneSuffix(hook.transcript_path ?? "")}`;
}

export function pushGate(hook: HookInput): never {
	if (process.env.SUSPENDERS_PUSH_TAIL === "0") allow();
	const laneId = laneIdFor(hook);
	if (!laneId) allow();
	const log = coordSubscribeLog(laneId);
	if (!existsSync(log)) allow();
	const stateFile = sessionStatePath("subtail", laneId);
	const prev = readSessionState<{ off: number }>(stateFile)?.off ?? 0;
	const r = tailSubscribeLog(log, prev);
	if (r.newOffset !== prev) writeSessionState(stateFile, { off: r.newOffset });
	if (r.text) context(r.text, "PostToolUse");
	allow();
}
