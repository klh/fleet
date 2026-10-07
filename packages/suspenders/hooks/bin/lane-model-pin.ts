#!/usr/bin/env bun
// lane-model-pin.ts — W512 Task-layer model pinning: a PreToolUse hook that
// rewrites Task tool calls (updatedInput) so subagent requests carry the
// dispatch-pinned model id at call time. Env-delivered pins die to
// claude-code's settings-env merge (user settings.json env OVER process env —
// probed live 2026-10-05, W250); hook-level injection bypasses that layer
// entirely.
//
// stdin  — PreToolUse payload: { tool_name, tool_input, ... }
// stdout — {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//          "updatedInput":{...tool_input, model}}} — updatedInput REPLACES
//          the tool input, so the full input object is re-emitted.
//
// Dispatch wires this hook into every lane's 0600 --settings file:
//   hooks.PreToolUse matcher "Task" → bun <prefix>/bin/lane-model-pin.ts --model <id>
//
// Fail-open: non-Task payloads, malformed stdin, or a missing --model exit 0
// with no output — a pin miss degrades to env inheritance, never blocks a
// lane's tool call (exit 2 is the only blocking exit; we never emit it).

/** The PreToolUse output for a Task call with `model` pinned; null = no
 *  decision (emit nothing, normal permission flow proceeds). Pure. */
export const taskPinOutput = (
	toolName: unknown,
	toolInput: unknown,
	model: string,
): Record<string, unknown> | null => {
	if (toolName !== "Task") return null;
	const input =
		toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
			? toolInput
			: {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			// no permissionDecision — the hook rewrites, the normal permission
			// flow still gates the call
			updatedInput: { ...(input as Record<string, unknown>), model },
		},
	};
};

const val = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

if (import.meta.main) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: lane-model-pin.ts --model <id>\n\nPreToolUse hook: rewrite Task tool calls with the pinned model (updatedInput). Non-Task payloads and any error exit 0 silently — fail-open by design.",
		);
		process.exit(0);
	}
	const model = val("--model");
	if (!model) {
		console.error(
			"lane-model-pin: --model <id> required (fail-open: skipping pin)",
		);
		process.exit(0);
	}
	let payload: { tool_name?: unknown; tool_input?: unknown };
	try {
		payload = JSON.parse(await Bun.stdin.text()) as typeof payload;
	} catch {
		process.exit(0); // malformed stdin — no decision, never block
	}
	const out = taskPinOutput(payload.tool_name, payload.tool_input, model);
	if (out) console.log(JSON.stringify(out));
}
