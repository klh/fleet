import { laneSettingsData } from "./lane-settings.ts";

type Hook = { command?: string; [key: string]: unknown };
type Group = { hooks?: Hook[]; [key: string]: unknown };
type Settings = {
	env: Record<string, string>;
	hooks?: Record<string, Group[]>;
	[key: string]: unknown;
};
/** Only Fleet-owned hook commands and the native effort pin are refreshed.
 * Provider key, routing headers, preferences and user settings remain exact. */
export function materializeRestartSettings(
	original: string,
	bin: string,
): { data: string; delta: string[] } {
	const source = JSON.parse(original) as Settings;
	if (
		!source.env ||
		typeof source.env.ANTHROPIC_DEFAULT_OPUS_MODEL !== "string"
	)
		throw new Error("Original lane model binding unavailable");
	const generated = JSON.parse(
		laneSettingsData(source.env, source.env.ANTHROPIC_DEFAULT_OPUS_MODEL, bin),
	) as Settings;
	const next = structuredClone(source);
	const delta: string[] = [];
	const effort = generated.env.CLAUDE_CODE_EFFORT_LEVEL;
	if (effort && next.env.CLAUDE_CODE_EFFORT_LEVEL !== effort) {
		next.env.CLAUDE_CODE_EFFORT_LEVEL = effort;
		delta.push("env.CLAUDE_CODE_EFFORT_LEVEL");
	}
	const owned = (command: string | undefined): "model" | "guard" | null =>
		command?.includes("/lane-model-pin.ts ")
			? "model"
			: command?.endsWith("/gate.ts runaway")
				? "guard"
				: null;
	const canonical = new Map<string, string>();
	for (const group of generated.hooks?.PreToolUse ?? [])
		for (const hook of group.hooks ?? []) {
			const kind = owned(hook.command);
			if (kind && hook.command) canonical.set(kind, hook.command);
		}
	const seen = new Set<string>();
	for (const [groupIndex, group] of (next.hooks?.PreToolUse ?? []).entries())
		for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
			const kind = owned(hook.command);
			if (!kind) continue;
			seen.add(kind);
			const command = canonical.get(kind);
			if (!command) throw new Error("Canonical owned hook missing");
			if (command !== hook.command) {
				hook.command = command;
				delta.push(`hooks.PreToolUse.${groupIndex}.hooks.${hookIndex}.command`);
			}
		}
	if (!seen.has("model") || !seen.has("guard"))
		throw new Error("Original Fleet-owned hook bindings incomplete");
	return { data: JSON.stringify(next), delta };
}
