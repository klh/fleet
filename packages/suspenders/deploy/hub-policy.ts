// Per-hub gateway policy rendering; the repository default stays byte-identical
// when no machine override is declared. Buckle remains the policy validator.
// W1253: the policy text is JSON — the one parser everywhere in the chain.
import { type GatewayPolicy, parsePolicy } from "../../buckle/src/policy.ts";

export function renderHubPolicy(
	baseText: string,
	gateway?: GatewayPolicy,
): string {
	if (gateway === undefined) return baseText;
	const base = JSON.parse(baseText) as Record<string, unknown> & {
		gateway?: Record<string, unknown>;
	};
	const text = `${JSON.stringify(
		{ ...base, gateway: { ...base.gateway, ...gateway } },
		null,
		"\t",
	)}\n`;
	parsePolicy(text);
	return text;
}
