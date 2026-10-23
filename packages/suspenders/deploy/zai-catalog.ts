// Account-visible Z.ai chat models. The authenticated catalog is the source;
// a hub route is generated only when the operator also configures LiteLLM.
import {
	chmodSync,
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	parseZaiModelIds,
	readZaiSnapshot,
	ZAI_CATALOG_URL,
	type ZaiCatalogSnapshot,
} from "../../belt/bin/zai-catalog-rows.ts";
import { assertProviderConcurrencyErrorCodes } from "../../buckle/src/provider-pressure.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

const MAX_CATALOG_BYTES = 1024 * 1024;

export async function fetchZaiCatalog(
	keyFile: string,
	fetcher: typeof fetch = fetch,
): Promise<ZaiCatalogSnapshot> {
	const stat = lstatSync(keyFile);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error("Z.ai key file must be a private regular file (0600)");
	const key = readFileSync(keyFile, "utf8").trim();
	if (!key) throw new Error("Z.ai key file is empty");
	const response = await fetcher(ZAI_CATALOG_URL, {
		headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok || !response.body)
		throw new Error(`Z.ai model catalog HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CATALOG_BYTES)
				throw new Error("Z.ai model catalog exceeds 1 MiB");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const parsed = parseZaiModelIds(JSON.parse(new TextDecoder().decode(body)));
	return {
		version: 1,
		source: ZAI_CATALOG_URL,
		generated_at: new Date().toISOString(),
		model_ids: parsed.model_ids,
		excluded_model_ids: parsed.excluded_model_ids,
	};
}

export function writeZaiSnapshot(
	path: string,
	snapshot: ZaiCatalogSnapshot,
): boolean {
	if (!path.startsWith("/"))
		throw new Error("Z.ai catalog path must be absolute");
	try {
		if (lstatSync(path).isSymbolicLink())
			throw new Error("Z.ai catalog path is a symlink");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const previous = (() => {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as ZaiCatalogSnapshot;
		} catch {
			return null;
		}
	})();
	const changed =
		JSON.stringify(previous?.model_ids) !==
			JSON.stringify(snapshot.model_ids) ||
		JSON.stringify(previous?.excluded_model_ids) !==
			JSON.stringify(snapshot.excluded_model_ids);
	const temp = join(dirname(path), `.zai-catalog-${crypto.randomUUID()}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temp, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* preserve the original error */
		}
		throw error;
	}
	return changed;
}

export function mergeZaiHubUpstreams(
	hub: HubProfile,
	groups: Record<string, Array<Record<string, unknown>>>,
	now = Date.now(),
): Record<string, Array<Record<string, unknown>>> {
	const path = hub.upstreams?.zai_catalog_file;
	if (!path) return groups;
	const url = hub.upstreams?.zai_litellm_url;
	if (
		!url ||
		!hub.http_upstream_hosts?.includes(new URL(url).hostname) ||
		!hub.secrets?.upstream_keys?.LITELLM_KEY ||
		hub.buckle_prefs?.allow_cloud !== true
	)
		throw new Error(
			"Z.ai catalog routes require allowed LiteLLM host, key, and cloud permission",
		);
	const snapshot = readZaiSnapshot(path, now);
	const pressureCodes = hub.upstreams?.zai_concurrency_error_codes;
	if (pressureCodes !== undefined)
		assertProviderConcurrencyErrorCodes(pressureCodes);
	for (const deployments of Object.values(groups)) {
		for (const deployment of deployments) {
			if (
				typeof deployment.url === "string" &&
				new URL(deployment.url).hostname === "api.z.ai"
			)
				throw new Error(
					"Z.ai hub has a direct provider route; migrate it through LiteLLM first",
				);
		}
	}
	const generated = Object.fromEntries(
		snapshot.model_ids.map((id) => [
			id,
			[
				{
					url,
					dialect: "openai",
					adapter: "openai-compat",
					model: `zai-${id}`,
					// W1122: generated rows ride the LiteLLM engine — declare it so
					// Buckle applies bounded proxy behavior (zero inner retries,
					// bounded first-byte headers) and route preflight passes.
					adapter_config: {
						proxy_kind: "litellm",
						...(pressureCodes === undefined
							? {}
							: { provider_concurrency_error_codes: pressureCodes }),
					},
					api_key_env: "LITELLM_KEY",
				},
			],
		]),
	);
	return { ...generated, ...groups };
}
