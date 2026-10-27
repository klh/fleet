// Claude tool hooks keep the parent's session_id and may keep its transcript
// path too. Prefer the explicit agent_id; older harnesses identify children
// through their /subagents/ transcript. Every ownership gate uses this seam.
import type { HookInput } from "./hookio.ts";

export function hookSubagentSuffix(hook: HookInput): string {
	const agent = typeof hook.agent_id === "string" ? hook.agent_id.trim() : "";
	if (agent) return `#${agent.startsWith("agent-") ? agent : `agent-${agent}`}`;
	const transcript = hook.agent_transcript_path ?? hook.transcript_path ?? "";
	const match = transcript.match(/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/);
	return match ? `#${match[1]}` : "";
}

export function hookLaneId(hook: HookInput): string {
	const sid = hook.session_id ?? "";
	if (!sid) return "";
	const suffix = hookSubagentSuffix(hook);
	return suffix ? `${sid.split("#")[0]}${suffix}` : sid;
}
