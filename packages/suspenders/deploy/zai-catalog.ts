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
	zaiCatalogFile,
	type ZaiCatalogSnapshot,
	ZaiSnapshotStaleError,
} from "../../belt/bin/zai-catalog-rows.ts";
import { assertProviderConcurrencyErrorCodes } from "../../buckle/src/provider-pressure.ts";
import { validateOutboundGuardConfig } from "../../buckle/src/outbound-guard.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import { readBoundedJson, readPrivateKey } from "./catalog-http.ts";

function guardedCodingPlanRoute(
	hub: HubProfile,
	group: string,
	deployment: Record<string, unknown>,
): boolean {
	if (group !== "glm-5.3-flash" || deployment.model !== group) return false;
	if (deployment.url !== "https://api.z.ai") return false;
	if (
		deployment.api_key_env !== "Z_AI_API_KEY" ||
		!hub.secrets?.upstream_keys?.Z_AI_API_KEY ||
		hub.buckle_prefs?.allow_cloud !== true
	)
		return false;
	const config = deployment.adapter_config as
		| Record<string, unknown>
		| undefined;
	const rewrite = config?.path_rewrite as Record<string, unknown> | undefined;
	const blocked = config?.blocked_outbound as
		| Record<string, unknown>
		| undefined;
	if (!rewrite || Object.keys(rewrite).length !== 1) return false;
	try {
		validateOutboundGuardConfig(config);
	} catch {
		return false;
	}
	if (
		!Array.isArray(blocked?.paths) ||
		!blocked.paths.includes("/api/paas/v4/")
	)
		return false;
	if (deployment.dialect === "anthropic")
		return (
			deployment.adapter === undefined &&
			rewrite["/v1/messages"] === "/api/anthropic/v1/messages" &&
			(blocked?.corrections as Record<string, unknown>)?.anthropic ===
				"https://api.z.ai/api/anthropic/v1/messages"
		);
	return (
		deployment.dialect === "openai" &&
		deployment.adapter === "openai-compat" &&
		rewrite["/v1/chat/completions"] ===
			"/api/coding/paas/v4/chat/completions" &&
		(blocked?.corrections as Record<string, unknown>)?.openai ===
			"https://api.z.ai/api/coding/paas/v4/chat/completions"
	);
}

export async function fetchZaiCatalog(
	keyFile: string,
	fetcher: typeof fetch = fetch,
): Promise<ZaiCatalogSnapshot> {
	const key = readPrivateKey(keyFile, "Z.ai");
	const response = await fetcher(ZAI_CATALOG_URL, {
		headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new Error(`Z.ai model catalog HTTP ${response.status}`);
	const parsed = parseZaiModelIds(
		await readBoundedJson(response, "Z.ai model catalog"),
	);
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

export type ZaiStaleResult =
	| { kind: "refreshed"; models: number }
	| { kind: "delta"; added: string[]; removed: string[] }
	| { kind: "failed"; why: string };

// Timestamp-only stale snapshot: rewrite in place only when the live chat model set matches. null = nothing to repair.
export async function refreshStaleZaiSnapshot(
	home: string,
	fetcher: typeof fetch = fetch,
	env: Record<string, string | undefined> = process.env,
): Promise<ZaiStaleResult | null> {
	const path = zaiCatalogFile(home, env);
	let stale: ZaiCatalogSnapshot;
	try {
		readZaiSnapshot(path);
		return null;
	} catch (error) {
		if (!(error instanceof ZaiSnapshotStaleError)) return null;
		stale = error.snapshot;
	}
	try {
		const keyFile = join(home, ".claude", "local-llm", "zai.key");
		const live = await fetchZaiCatalog(keyFile, fetcher);
		const added = live.model_ids.filter((id) => !stale.model_ids.includes(id));
		const removed = stale.model_ids.filter(
			(id) => !live.model_ids.includes(id),
		);
		if (added.length > 0 || removed.length > 0)
			return { kind: "delta", added, removed };
		writeZaiSnapshot(path, live);
		return { kind: "refreshed", models: live.model_ids.length };
	} catch (error) {
		return {
			kind: "failed",
			why: error instanceof Error ? error.message : String(error),
		};
	}
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
	for (const [group, deployments] of Object.entries(groups)) {
		for (const deployment of deployments) {
			if (
				typeof deployment.url === "string" &&
				new URL(deployment.url).hostname === "api.z.ai" &&
				!guardedCodingPlanRoute(hub, group, deployment)
			)
				throw new Error(
					"Z.ai hub has an unguarded direct provider route; use the Coding Plan Flash path and private key",
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
