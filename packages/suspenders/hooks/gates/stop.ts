// hooks/gates/stop.ts — Stop: the claim-done gate. Re-runs syntax gates over
// changed files + conflict-marker check before the turn may end. TS fixes
// from the hooks-review: porcelain -z parsing (spaces/renames safe),
// JSON.stringify-built payloads (no printf-JSON corruption), bounded loop
// matching the list cap, files newer than a cap only.
// W14: re-verify runs filesCheck IN-PROCESS — the old loop spawned one
// `bun gate.ts post-files` per changed file (up to 50 bun processes per Stop).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { openStore } from "../lib/govdb.ts";
import { claudeStopPause } from "../lib/claude-pause.ts";
import { allow, feedback, type HookInput } from "../lib/hookio.ts";
import { laneCompletion } from "../lib/lane-completion.ts";
import { run } from "../lib/run.ts";
import { touchSessionHeartbeat } from "../lib/session-bridge.ts";
import { syncNativeRename } from "../lib/session-rename.ts";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "../lib/session-state.ts";
import { resolveTranscriptPath, transcriptTail } from "../lib/transcript.ts";
import {
	pendingTurnMessages,
	turnBoundaryFeedback,
	turnBoundarySid,
} from "../lib/turn-boundary.ts";
import { filesCheck } from "./files.ts";

const CODE_EXT =
	/\.(json|py|sh|bash|zsh|dash|ts|tsx|js|jsx|mjs|cjs|mts|cts|yaml|yml|toml)$/i;

// W642: context-pressure stop guard (research-oh-my-claudecode §1.1 /
// research-oh-my-claude L2). Converts silent context exhaustion into one
// cheap, bounded intervention: at >= GUARD pct block the stop with a
// checkpoint directive, max 2 blocks/session.
const GUARD_PCT = Math.min(
	99,
	Math.max(1, Number(process.env.SUSPENDERS_CONTEXT_GUARD_PCT ?? 75) || 75),
);
const CRITICAL_PCT = Math.min(
	100,
	Math.max(1, Number(process.env.SUSPENDERS_CONTEXT_CRITICAL_PCT ?? 95) || 95),
);
const CONTEXT_GUARD_CAP = 2;
const ABORT_OR_LIMIT =
	/\[Request interrupted by user|"isApiErrorMessage":true|usage limit|credit balance|rate limit/i;

/** The pressure reading: native used_percentage when the harness supplies
 * it, else the transcript's last usage object (input + cache tokens) over
 * the 200k default window. null = unmeasurable — the guard never fires. */
function contextPressure(
	hook: HookInput,
	transcript: string | null,
): number | null {
	const native = (hook as { context_window?: { used_percentage?: unknown } })
		.context_window?.used_percentage;
	if (typeof native === "number") return native;
	if (!transcript) return null;
	const m = transcriptTail(transcript, 16_384).match(
		/"usage":(\{[^{}]*\})(?![\s\S]*"usage":\{)/,
	);
	if (!m) return null;
	try {
		const usage = JSON.parse(m[1]) as {
			input_tokens?: unknown;
			cache_creation_input_tokens?: unknown;
			cache_read_input_tokens?: unknown;
		};
		const num = (v: unknown) => (typeof v === "number" ? v : 0);
		const tokens =
			num(usage.input_tokens) +
			num(usage.cache_creation_input_tokens) +
			num(usage.cache_read_input_tokens);
		const window = (
			hook as { context_window?: { context_window_size?: unknown } }
		).context_window?.context_window_size;
		const size = typeof window === "number" && window > 0 ? window : 200_000;
		return tokens <= 0 ? null : Math.min(100, (tokens / size) * 100);
	} catch {
		return null;
	}
}

/** One bounded intervention: at >= GUARD pct block the stop with a checkpoint
 * directive — max 2/session (per-session guard file via session-state, atomic
 * 0600), never at >= CRITICAL (that deadlocks compaction), never on an
 * abort/limit stop. Any state failure fails open. */
function contextPressureGuard(hook: HookInput): void {
	const h = hook as HookInput & {
		session_id?: string;
		transcript_path?: string;
	};
	if (!h.session_id) return;
	const transcript = resolveTranscriptPath(h);
	const pct = contextPressure(h, transcript);
	if (pct === null || pct < GUARD_PCT) return;
	if (pct >= CRITICAL_PCT) return; // blocking there deadlocks compaction
	if (transcript && ABORT_OR_LIMIT.test(transcriptTail(transcript, 4096)))
		return; // abort/limit stops: blocking those deadlocks the harness
	const file = sessionStatePath("ctx-guard", h.session_id);
	const state = readSessionState<{ blocks?: unknown }>(file) ?? {};
	const blocks = typeof state.blocks === "number" ? state.blocks : 0;
	if (blocks >= CONTEXT_GUARD_CAP) return;
	writeSessionState(file, { blocks: blocks + 1, pct, ts: Date.now() });
	feedback(
		`CONTEXT PRESSURE ${Math.round(pct)}% — checkpoint NOW before compaction loses in-flight state: ` +
			`commit progress, then bank a capsule (coord capsule set --as ${h.session_id} --checkpoint=<head> --done=<progress> --next=<step>), ` +
			`then continue. This guard blocks at >=${GUARD_PCT}% (max ${CONTEXT_GUARD_CAP}/session) and stands down at >=${CRITICAL_PCT}%.`,
	);
}

export function stopGate(hook: HookInput): never {
	// W294 plane heartbeat: every turn's stop refreshes the session row's hb
	// (all dialects share this gate) and fills an empty transcript_path —
	// fail-open inside the touch, never blocks the checks below.
	touchSessionHeartbeat(hook.session_id, hook.transcript_path);
	// W930 native-rename sync: a CLI-native /rename (claude-code custom-title)
	// lands in sessions.tags at the same fail-open seam every dialect rides.
	syncNativeRename(hook);
	// W516 turn-boundary drain (the amp M3 lift): operator direct-messages
	// queue while the agent works and are processed HERE, at the turn
	// boundary, including interactive sessions. Direct coordination takes
	// priority over completion retries. No session identity or
	// control plane → nothing to drain, the gate allows.
	const drainCwd = hook.cwd ?? "";
	if (drainCwd && existsSync(drainCwd)) {
		const laneSid = turnBoundarySid(hook);
		if (laneSid) {
			try {
				const store = openStore();
				const pause = claudeStopPause(store, laneSid, drainCwd);
				if (pause === "paused") allow();
				if (pause) feedback(pause);
				const f = turnBoundaryFeedback(
					pendingTurnMessages(store, laneSid),
					laneSid,
				);
				if (f) feedback(f);
			} catch {
				// no control plane reachable — the drain is a lane concern only
			}
		}
	}
	const incomplete = laneCompletion(hook);
	if (incomplete) feedback(incomplete);

	// W642: context-pressure guard — capacity check after the claim checks;
	// fires only when the stop was otherwise allowed.
	contextPressureGuard(hook);

	// W1146: the W497 session-end knowledge ask is RETIRED from Stop — the
	// live WS/CLI Stop event is end-of-TURN, not session end, so the ask
	// re-prompted on ordinary answer boundaries (transcript > 20KB makes it
	// unconditional). Passive knowledge write-back rides the true SessionEnd
	// settle (hooks/lib/settle.ts via hooks/session-end.ts); deliberate
	// donation stays a lane choice (coord knowledge-enqueue / fact set).

	const cwd = hook.cwd ?? "";
	if (!cwd || !existsSync(cwd)) allow();
	if (!run("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok) allow();

	// -z: NUL-separated, rename targets after " -> ", quoted paths intact
	const st = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
		cwd,
		encoding: "buffer",
	});
	if (st.status !== 0) allow();
	const fields = st.stdout.toString("utf8").split("\0").filter(Boolean);

	const files = new Set<string>();
	for (const f of fields) {
		let path = f.slice(3); // strip XY + space
		const arrow = path.indexOf(" -> ");
		if (arrow !== -1) path = path.slice(arrow + 4); // renamed: check the TARGET
		if (!path || path.includes(".claude/")) continue;
		if (CODE_EXT.test(path)) files.add(path);
	}
	if (files.size === 0) allow();

	const failures: string[] = [];

	// unmerged paths block outright
	for (const f of fields) {
		if (f.startsWith("UU") || f.startsWith("AA") || f.startsWith("DD"))
			failures.push(`unmerged: ${f.slice(3)}`);
	}

	// bounded re-verification via the same files gate (syntax only), in-process
	let n = 0;
	for (const rel of files) {
		if (++n > 50) {
			failures.push("(more than 50 changed files — verify the rest manually)");
			break;
		}
		const abs = `${cwd.replace(/\/$/, "")}/${rel}`;
		if (!existsSync(abs)) continue;
		const payload = {
			tool_name: "Write",
			tool_input: { file_path: abs },
			_deferred_fmt: true,
		} as HookInput;
		const v = filesCheck(payload);
		if (v.kind === "block" || v.kind === "feedback")
			failures.push((v.err ?? v.msg).trim());
	}

	if (failures.length)
		feedback(
			`STOP-GATE: not done yet — fix these before claiming completion:\n${failures.join("\n")}`,
		);

	allow();
}
