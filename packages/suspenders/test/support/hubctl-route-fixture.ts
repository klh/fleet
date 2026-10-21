import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

/** Isolate hubctl lifecycle tests from the operator's live route policy. */
export function hubctlRouteFixture(dir: string): Record<string, string> {
	const basePath = join(import.meta.dir, "../../../buckle/upstreams.yaml");
	const base = YAML.parse(readFileSync(basePath, "utf8")) as {
		groups: Record<string, unknown>;
	};
	const groups = Object.fromEntries(
		Object.keys(base.groups).map((group) => [group, []]),
	);
	groups["preflight-source"] = [
		{ url: "https://api.openai.com/v1", dialect: "openai" },
	];
	groups["preflight-fallback"] = [
		{ url: "https://api.openai.com/v1", dialect: "openai" },
	];
	const upstreams = join(dir, "preflight-upstreams.json");
	const policy = join(dir, "preflight-policy.json");
	const litellm = join(dir, "preflight-litellm.json");
	writeFileSync(upstreams, JSON.stringify({ version: 1, groups }));
	writeFileSync(
		policy,
		JSON.stringify({
			gateway: {
				fallbacks: { "preflight-source": ["preflight-fallback"] },
				num_retries: 0,
			},
		}),
	);
	writeFileSync(litellm, JSON.stringify({ model_list: [] }));
	return {
		BUCKLE_UPSTREAMS: upstreams,
		BUCKLE_POLICY: policy,
		LITELLM_CONFIG: litellm,
	};
}
