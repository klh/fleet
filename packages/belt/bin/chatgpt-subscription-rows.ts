/** Operator-selected ChatGPT subscription models for the LiteLLM gateway. */
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/;

export function chatGptSubscriptionRows(raw: unknown): string[] {
	if (!Array.isArray(raw))
		throw new Error("ChatGPT subscription models must be an array");
	const names = new Set<string>();
	for (const model of raw) {
		if (typeof model !== "string" || !MODEL_RE.test(model))
			throw new Error("invalid ChatGPT subscription model id");
		names.add(model);
	}
	return [...names].map(
		(model) =>
			`  - model_name: chatgpt/${model}\n` +
			`    model_info:\n` +
			`      mode: responses\n` +
			`    litellm_params:\n` +
			`      model: chatgpt/${model}`,
	);
}
