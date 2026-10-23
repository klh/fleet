import {
	validatedMetricsUrl,
	validMetricsSourceId,
} from "../../buckle/src/metrics-connector.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** Project trusted operator data only. Values stay in the existing on-hub
 * upstream.env; no additional credential store, mounts or scrape process. */
export function hubMetricsEnv(hub: HubProfile): Record<string, string> {
	if (hub.metrics === undefined) return {};
	const config = hub.metrics?.litellm;
	if (
		!config ||
		Object.keys(hub.metrics).some((key) => key !== "litellm") ||
		Object.keys(config).some(
			(key) => !["url", "key_env", "source_id"].includes(key),
		) ||
		typeof config.url !== "string" ||
		typeof config.key_env !== "string" ||
		typeof config.source_id !== "string" ||
		!validMetricsSourceId(config.source_id)
	)
		throw Error("hub metrics.litellm requires only url, key_env and source_id");
	const url = validatedMetricsUrl(config.url);
	const name = config.key_env;
	if (!url || !/^[A-Z_][A-Z0-9_]*$/.test(name))
		throw Error("hub metrics.litellm URL or credential name is invalid");
	const bindings = hub.secrets?.upstream_keys;
	if (
		!bindings ||
		!Object.hasOwn(bindings, name) ||
		typeof bindings[name] !== "string" ||
		!bindings[name].trim()
	)
		throw Error(
			"hub metrics.litellm key_env must name a declared upstream_keys binding",
		);
	return {
		HUB_LITELLM_METRICS_URL: url.href,
		HUB_LITELLM_METRICS_KEY_ENV: name,
		HUB_LITELLM_METRICS_SOURCE_ID: config.source_id,
	};
}
