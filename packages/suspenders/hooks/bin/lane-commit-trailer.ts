#!/usr/bin/env bun
// lane-commit-trailer.ts — W1141 transcript tracing: a PreToolUse hook that
// rewrites Bash `git commit` calls (updatedInput, the W512 channel) so every
// lane commit carries `Fleet-Session: <sid>` / `Fleet-Item: <item>` trailers
// (Claude-Session-style). The done gate (lib/lane-guard.ts trailerVerdict)
// verifies they landed — audit default, SUSPENDERS_TRAILER_GATE=enforce.
//
// stdin  — PreToolUse payload: { tool_name, tool_input: { command } }
// stdout — {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//          "updatedInput":{...input, command: <with trailers>}}}
//
// Identity: --sid/--item args when dispatch pins them, else the lane context
// (`.fleet/lane-context.json` under the hook's cwd — dispatch writes it at
// activation). Fail-open by design: non-commit payloads, malformed stdin, a
// missing identity or any error exit 0 with no output — a trailer miss is a
// gate finding, never a blocked tool call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fleetTrailerArgs } from "../lib/lane-guard.ts";

/** The git-commit command with trailer flags appended; null when the call is
 *  not a bare `git commit` (or already carries --trailer). Pure. */
export function commitWithTrailers(
	command: string,
	sid: string,
	item: string,
): string | null {
	const t = command.trim();
	if (!/^git(\s+-\S+)*\s+commit\b/.test(t)) return null;
	if (t.includes("--trailer") || t.includes("--amend")) return null;
	if (t.includes("-m") || t.includes("--message") || t.includes("--file")) {
		return `${command} ${fleetTrailerArgs(sid, item).map(quoteArg).join(" ")}`;
	}
	return null;
}

const quoteArg = (arg: string): string =>
	arg.includes("'") ? JSON.stringify(arg) : `'${arg}'`;

/** sid/item from the activation context dispatch wrote; null when absent. */
export function laneIdentityFromContext(
	cwd: string,
): { sid: string; item: string } | null {
	const f = join(cwd, ".fleet", "lane-context.json");
	if (!existsSync(f)) return null;
	try {
		const raw = JSON.parse(readFileSync(f, "utf8")) as {
			sid?: unknown;
			item?: unknown;
		};
		return typeof raw.sid === "string" && typeof raw.item === "string"
			? { sid: raw.sid, item: raw.item }
			: null;
	} catch {
		return null;
	}
}

/** The PreToolUse output for a Bash git-commit call with the trailers
 *  injected; null = no decision (emit nothing, normal flow proceeds). Pure. */
export function commitTrailerOutput(
	toolName: unknown,
	toolInput: unknown,
	sid: string,
	item: string,
): Record<string, unknown> | null {
	if (toolName !== "Bash") return null;
	const input =
		toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
			? (toolInput as Record<string, unknown>)
			: {};
	if (typeof input.command !== "string") return null;
	const rewritten = commitWithTrailers(input.command, sid, item);
	if (!rewritten) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			// no permissionDecision — the hook rewrites, the normal permission
			// flow still gates the call
			updatedInput: { ...input, command: rewritten },
		},
	};
}

const val = (flagName: string): string | undefined => {
	const i = process.argv.indexOf(flagName);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

if (import.meta.main) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: lane-commit-trailer.ts [--sid <sid>] [--item <id>]\n\nPreToolUse hook: rewrite Bash git-commit calls so lane commits carry Fleet-Session/Fleet-Item trailers (updatedInput). Identity falls back to .fleet/lane-context.json under cwd. Non-commit payloads and any error exit 0 silently — fail-open by design.",
		);
		process.exit(0);
	}
	const ident =
		val("--sid") && val("--item")
			? { sid: val("--sid") as string, item: val("--item") as string }
			: laneIdentityFromContext(process.cwd());
	if (!ident) process.exit(0); // no identity — fail-open
	let payload: { tool_name?: unknown; tool_input?: unknown };
	try {
		payload = JSON.parse(await Bun.stdin.text()) as typeof payload;
	} catch {
		process.exit(0); // malformed stdin — no decision, never block
	}
	const out = commitTrailerOutput(
		payload.tool_name,
		payload.tool_input,
		ident.sid,
		ident.item,
	);
	if (out) console.log(JSON.stringify(out));
}
