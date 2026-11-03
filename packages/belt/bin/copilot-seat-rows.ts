/** W2595: GitHub Copilot seat rows for the LiteLLM gateway.
 *
 * litellm 1.103.0 ships a native github_copilot provider: the messages
 * transformation is an Anthropic /v1/messages passthrough (drop_params eats
 * thinking/reasoning_effort/effort/anthropic_beta/parallel_tool_calls the
 * direct wire 400s — proven live 2026-11-03 on a scratch :4199) and the
 * chat handler rides /chat/completions. Auth is the seeded token cache:
 * the authenticator reads GITHUB_COPILOT_TOKEN_DIR/access-token and
 * api-key.json FIRST (device flow is fallback-only, never forced).
 *
 * The operator selects models through the same 0600 opt-in file pattern as
 * the ChatGPT subscription rows (copilot-models.json); its absence leaves
 * the provider out of the catalog. */
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/;

export function copilotSeatRows(raw: unknown): string[] {
	if (!Array.isArray(raw))
		throw new Error("Copilot seat models must be an array");
	const names = new Set<string>();
	for (const model of raw) {
		if (typeof model !== "string" || !MODEL_RE.test(model))
			throw new Error("invalid Copilot seat model id");
		names.add(model);
	}
	return [...names].map(
		(model) =>
			`  - model_name: copilot/${model}\n` +
			`    litellm_params:\n` +
			`      model: github_copilot/${model}\n` +
			`    model_info:\n` +
			`      disable_background_health_check: true`,
	);
}
