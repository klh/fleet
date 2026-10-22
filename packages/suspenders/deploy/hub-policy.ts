// Per-hub gateway policy rendering; the repository default stays byte-identical
// when no machine override is declared. Buckle remains the policy validator.
import { YAML } from "bun";
import { stringify } from "yaml";
import { type GatewayPolicy, parsePolicy } from "../../buckle/src/policy.ts";

export function renderHubPolicy(
	baseText: string,
	gateway?: GatewayPolicy,
): string {
	if (gateway === undefined) return baseText;
	const base = YAML.parse(baseText);
	const text = stringify({ ...base, gateway: { ...base.gateway, ...gateway } });
	parsePolicy(text);
	return text;
}
