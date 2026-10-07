// hooks/lib/hookio.ts — the ONE definition of hook input/output contracts.
// Every gate imports from here; no gate builds its own JSON or exit codes.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "./session-state.ts";

export type HookInput = {
	tool_name?: string;
	session_id?: string;
	tool_input?: {
		command?: string;
		file_path?: string;
		notebook_path?: string;
		old_string?: string;
		new_string?: string;
	};
	cwd?: string;
	stop_hook_active?: boolean;
	hook_event_name?: string;
};

// Codex dialect seam (W73): gates keep ZERO codex knowledge — helpers route
// through the installed dialect when gate.ts binds one (`bun gate.ts codex
// <event>`); Claude behavior is the default (null).
export type DialectDecision = {
	stdout?: string;
	stderr?: string;
	exit: number;
};
export type HookDialect = {
	decide(kind: string, event: string, arg: string): DialectDecision;
};
let DIALECT: HookDialect | null = null;
export function setDialect(d: HookDialect): void {
	DIALECT = d;
}

function outD(d: DialectDecision): never {
	if (d.stdout !== undefined) process.stdout.write(d.stdout);
	if (d.stderr !== undefined) process.stderr.write(d.stderr);
	process.exit(d.exit);
}

// The current hook input, stashed by readHook() so the decision helpers
// (deny/audit) can see what is being decided without a signature change at
// 17 call sites. Direct-lib callers (unit tests) leave it empty — audit
// fields then degrade to "" honestly.
let HOOK: HookInput = {};

export async function readHook(): Promise<HookInput> {
	try {
		HOOK = JSON.parse(await new Response(Bun.stdin).text());
	} catch {
		HOOK = {};
	}
	return HOOK;
}

// ---- denied-call audit (W80) ----
// Every gate denial lands here: one JSONL line, fire-and-forget, in the
// global cache (same dir as govdb REG and the motd). Evidence, not a gate:
// an append failure must never break the deny path. Sensitivity: cmd
// snippets are truncated, NOT redacted — the log inherits transcript-level
// sensitivity and is a strict subset of what the transcript already records.
export function auditPath(): string {
	return `${process.env.HOME ?? ""}/.cache/claude-governor/denied-calls.jsonl`;
}

export function auditDeny(reason: string): void {
	try {
		const file = auditPath();
		mkdirSync(dirname(file), { recursive: true });
		const ti = HOOK.tool_input ?? {};
		const line = {
			at: new Date().toISOString(),
			event: process.argv[2] ?? "",
			tool: HOOK.tool_name ?? "",
			cmd: (ti.command ?? "").slice(0, 200),
			path: (ti.file_path ?? ti.notebook_path ?? "").slice(0, 300),
			cwd: process.cwd(),
			reason: reason.slice(0, 300),
		};
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		// fire-and-forget: audit failures never break the deny path
	}
}

export function allow(): never {
	if (DIALECT) outD(DIALECT.decide("allow", "", ""));
	process.stdout.write("{}");
	process.exit(0);
}
export function deny(reason: string): never {
	auditDeny(reason); // evidence before exit — codex dialect denials land here too
	if (DIALECT) outD(DIALECT.decide("deny", "", reason));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	});
}
export function ask(reason: string): never {
	if (DIALECT) outD(DIALECT.decide("ask", "", reason));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: reason,
		},
	});
}
// sha-keyed advisory cooldown (claudecode research §1.6): identical nudge
// text on every tool call burns context and trains the model to ignore it.
// Per-session (HOOK.session_id), 5-minute default (SUSPENDERS_NUDGE_COOLDOWN_MS
// override, 0 disables), 100-entry cap, fails OPEN — throttling must never
// silence a safety message (denials ride deny()/ask(), never this channel).
const NUDGE_COOLDOWN_MS = Math.max(
	0,
	Number(process.env.SUSPENDERS_NUDGE_COOLDOWN_MS ?? 300_000) || 0,
);
const NUDGE_COOLDOWN_CAP = 100;

function nudgeSuppressed(message: string): boolean {
	if (NUDGE_COOLDOWN_MS === 0) return false;
	const sid = HOOK.session_id;
	if (!sid) return false; // no session context → always emit
	try {
		return nudgeSuppressedIn(message, sessionStatePath("nudge", sid));
	} catch {
		return false;
	}
}

function nudgeSuppressedIn(message: string, file: string): boolean {
	const key = createHash("sha256").update(message).digest("hex").slice(0, 16);
	const state = readSessionState<Record<string, number>>(file) ?? {};
	const now = Date.now();
	const last = state[key];
	if (last !== undefined && now - last < NUDGE_COOLDOWN_MS) return true;
	// record this show: prune expired entries, then cap at the newest 100
	for (const k of Object.keys(state))
		if (now - state[k] >= NUDGE_COOLDOWN_MS) delete state[k];
	state[key] = now;
	const keys = Object.keys(state);
	if (keys.length > NUDGE_COOLDOWN_CAP)
		for (const k of keys
			.sort((a, b) => state[a] - state[b])
			.slice(0, keys.length - NUDGE_COOLDOWN_CAP))
			delete state[k];
	writeSessionState(file, state); // write failure = fail open, nudge emits
	return false;
}

export function nudge(message: string): never {
	if (nudgeSuppressed(message)) allow(); // throttled → plain allow, dialect-aware
	if (DIALECT) outD(DIALECT.decide("nudge", "", message));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			additionalContext: message,
		},
	});
}
export function context(message: string, event = "SessionStart"): never {
	if (DIALECT) outD(DIALECT.decide("context", event, message));
	out({
		hookSpecificOutput: { hookEventName: event, additionalContext: message },
	});
}
export function feedback(message: string): never {
	// PostToolUse / Stop: exit 2 feeds stderr back to the agent (non-blocking,
	// the tool already ran) — the ONE definition of the feedback channel.
	if (DIALECT) outD(DIALECT.decide("feedback", "", message));
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function out(obj: unknown): never {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}
