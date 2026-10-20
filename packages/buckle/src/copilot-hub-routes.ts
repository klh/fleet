// Keep Copilot model names on the Mac, but send their first hop through the
// Docker IKEA Buckle. The hub owns the provider credential and model catalog.

interface Deployment {
	url: string;
	dialect?: string;
	adapter?: string;
	model?: string;
	api_key_env?: string;
	[key: string]: unknown;
}

export interface UpstreamConfig {
	version?: number;
	groups: Record<string, Deployment[]>;
	[key: string]: unknown;
}

export function preferCopilotHub(
	local: UpstreamConfig,
	hubGroups: Record<string, unknown>,
	hubUrl: string,
): { config: UpstreamConfig; routed: string[] } {
	const routed = Object.keys(hubGroups);
	if (routed.length === 0) throw new Error("IKEA hub has no model groups");
	const missing = routed.filter((name) => !Array.isArray(local.groups[name]));
	if (missing.length)
		throw new Error(`Mac upstream groups missing: ${missing.join(", ")}`);
	const groups = { ...local.groups };
	for (const name of routed) {
		const anthropic = name.startsWith("claude-");
		const peer: Deployment = {
			url: hubUrl,
			dialect: anthropic ? "anthropic" : "openai",
			adapter: anthropic ? "anthropic" : "openai-compat",
			model: name,
			api_key_env: "IKEA_HUB_KEY",
		};
		groups[name] = [
			peer,
			...(groups[name] ?? []).filter(
				(row) =>
					row.url !== hubUrl && row.url !== "https://api.githubcopilot.com",
			),
		];
	}
	return { config: { ...local, groups }, routed };
}
