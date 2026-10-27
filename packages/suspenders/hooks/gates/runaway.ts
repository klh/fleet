// hooks/gates/runaway.ts — W830 PreToolUse live breaker for lanes: reads the
// session transcript before each call and blocks via the permissionDecision
// deny channel (hookio.deny — the audited, dialect-aware route) when
//   · the same tool+args call repeats back-to-back past
//     SUSPENDERS_RUNAWAY_REPEAT_MAX (W1079: consecutive run, not tail-wide),
//   · SUSPENDERS_RUNAWAY_FAIL_STREAK consecutive tool results failed, or
//   · session spend (transcript usage × SUSPENDERS_RUNAWAY_USD_RATES) hits
//     SUSPENDERS_RUNAWAY_USD_CAP (0 = dollar breaker disabled — the stack
//     carries no hardcoded pricing).
// Incidents land on the lane incidents.jsonl (`<cwd>/.fleet/incidents.jsonl`
// when the lane context dir exists, else the global cache file). Resolution
// miss or state failure fails OPEN (W642 law) — the guard never blocks a
// healthy call because its evidence is unreadable.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { allow, deny, type HookInput } from "../lib/hookio.ts";
import { resolveFleetLane } from "../lib/lanes/fleetlane.ts";
import {
	readUsageDelta,
	readUsageState,
	runawayConfig,
	scanTail,
	stableKey,
	writeUsageState,
} from "../lib/gates/runaway.ts";
import {
	resolveTranscriptPath,
	transcriptTail,
} from "../lib/lanes/transcript.ts";

// the lane's own incident ledger: worktree lanes write `.fleet/` beside the
// lane context; anything else falls back to the global cache (W80 pattern)
function incidentPath(cwd?: string): string {
	if (cwd && existsSync(`${cwd}/.fleet`))
		return `${cwd}/.fleet/incidents.jsonl`;
	return `${process.env.HOME ?? ""}/.cache/claude-governor/runaway-incidents.jsonl`;
}

function incident(hook: HookInput, rule: string, detail: string): void {
	try {
		const file = incidentPath(hook.cwd);
		mkdirSync(dirname(file), { recursive: true });
		const line = {
			at: new Date().toISOString(),
			sid: hook.session_id ?? "",
			lane: resolveFleetLane(hook.cwd ?? process.cwd())?.sid ?? "",
			rule,
			detail: detail.slice(0, 300),
			tool: hook.tool_name ?? "",
			action: "blocked",
		};
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		// fire-and-forget: an incident append never breaks the deny path
	}
}

export function runawayGate(hook: HookInput): never {
	const cfg = runawayConfig();
	const sid = hook.session_id;
	const tool = hook.tool_name;
	if (cfg.disabled || !sid || !tool) allow();
	const tp = resolveTranscriptPath(hook);
	if (!tp) allow(); // resolution miss never flips a verdict (W642)
	const tail = transcriptTail(tp, cfg.tailBytes);
	const v = scanTail(tail, tool, stableKey(hook.tool_input ?? {}));
	if (v.repeats >= cfg.repeatMax) {
		const detail = `${tool} identical-args call #${v.repeats + 1} back-to-back (cap ${cfg.repeatMax}) in the recent transcript window`;
		incident(hook, "repeat", detail);
		deny(
			`runaway-guard: ${detail}. This call is blocked — change the approach or the arguments; re-running the same call is a loop, not progress.`,
		);
	}
	if (v.failStreak >= cfg.failStreak) {
		const detail = `${v.failStreak} consecutive tool failures (cap ${cfg.failStreak})`;
		incident(hook, "fail-streak", detail);
		deny(
			`runaway-guard: ${detail}. This call is blocked until the method changes — re-read the actual error, change one thing, or coord consult --best "<command, error, attempts>".`,
		);
	}
	const st = readUsageState(sid);
	const st2 = readUsageDelta(tp, st, cfg.rates, cfg.scanCapBytes);
	writeUsageState(sid, st2);
	if (cfg.usdCap > 0 && st2.costUsd >= cfg.usdCap) {
		const detail = `session spend $${st2.costUsd.toFixed(2)} >= cap $${cfg.usdCap.toFixed(2)}`;
		incident(hook, "dollar", detail);
		deny(
			`runaway-guard: ${detail}. Wrap up and report — further spend needs the operator to raise SUSPENDERS_RUNAWAY_USD_CAP.`,
		);
	}
	allow();
}
