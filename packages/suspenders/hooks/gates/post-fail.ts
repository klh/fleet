// hooks/gates/post-fail.ts — PostToolUse failure counter gate: counts the
// same failing call per session in a 60 s window (lib/tool-failures.ts) and
// injects escalating guidance, anti-thrash at >=5 (W514, claudecode research
// §1.5). Wired on PostToolUse for Bash|Edit|Write|NotebookEdit; reads the
// tool_response error signal and stays silent otherwise (gates that act,
// stay silent otherwise). Interrupts and noise classes never count.
import { allow, feedback, type HookInput } from "../lib/hookio.ts";
import { isNoise, recordToolFailure } from "../lib/tool-failures.ts";

type PostToolPayload = HookInput & {
	tool_response?: unknown;
};

// failure = the tool_response error signal; user interrupts never fire
function failed(response: unknown): boolean {
	const r = response as
		| {
				is_error?: boolean;
				success?: boolean;
				interrupted?: boolean;
		  }
		| undefined;
	if (!r || r.interrupted) return false;
	return r.is_error === true || r.success === false;
}

// best-effort error snippet from whatever the payload carries
function errorText(response: unknown): string {
	if (typeof response === "string") return response.slice(0, 300);
	const r = response as
		| { stderr?: unknown; error?: unknown; content?: unknown }
		| undefined;
	const raw = r?.error ?? r?.stderr ?? r?.content;
	if (typeof raw === "string") return raw.slice(0, 300);
	if (raw != null) return JSON.stringify(raw).slice(0, 300);
	return "";
}

export function postFailGate(hook: HookInput): never {
	const h = hook as PostToolPayload;
	const sid = h.session_id;
	const tool = h.tool_name;
	if (!sid || !tool) allow();
	const err = errorText(h.tool_response);
	if (!failed(h.tool_response)) allow();
	if (isNoise(h.tool_input?.command, err)) allow();
	const r = recordToolFailure(sid, tool, h.tool_input, err);
	if (r.guidance) feedback(r.guidance);
	allow();
}
