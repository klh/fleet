// W1029.1: fleet-loop face of the authenticated Z.ai account catalog. For
// every hub that configures a zai_catalog_file, fetch the account-visible
// chat models with the hub's key path, and when the route set changed,
// regenerate litellm.yaml with BOTH catalog snapshots (the serialization
// contract with the OpenRouter refresh — one :4100 engine), restart the
// engine, wait until the zai-<id> rows are live, then reload the affected
// Buckle hub. The applied marker advances only after activation succeeds —
// a failure keeps the previous marker (last-good routes keep serving) and
// retries at the next cadence.
import { join } from "node:path";
import type { HubProfile, StackConfig } from "../hooks/lib/stack-config.ts";
import type { ZaiCatalogSnapshot } from "../../belt/bin/zai-catalog-rows.ts";
import * as activation from "./litellm-activation.ts";
import { fetchZaiCatalog, writeZaiSnapshot } from "./zai-catalog.ts";

export interface ZaiRefreshDeps {
	/** Catalog fetch override (tests). */
	fetcher?: typeof fetch;
	/** Activation seam overrides (tests capture the sequence). */
	activation?: {
		run?: typeof activation.runCommand;
		restartLiteLLM?: () => void;
		waitForLiteLLMModels?: (names: string[]) => Promise<void>;
		appliedHash?: (path: string) => string | null;
		writeAppliedHash?: (path: string, hash: string) => void;
	};
}

const activationSeam = (deps: ZaiRefreshDeps) => ({
	run: deps.activation?.run ?? activation.runCommand,
	restart: deps.activation?.restartLiteLLM ?? activation.restartLiteLLM,
	wait:
		deps.activation?.waitForLiteLLMModels ?? activation.waitForLiteLLMModels,
	applied: deps.activation?.appliedHash ?? activation.appliedHash,
	writeApplied:
		deps.activation?.writeAppliedHash ?? activation.writeAppliedHash,
});

const activateZaiHub = async (
	name: string,
	path: string,
	hub: HubProfile,
	snapshot: ZaiCatalogSnapshot,
	hash: string,
	act: ReturnType<typeof activationSeam>,
): Promise<string> => {
	if (process.platform !== "darwin" || hub.deploy?.ssh)
		throw new Error(
			`${name}: automatic LiteLLM reload currently requires a local macOS hub`,
		);
	// Serialization contract: ONE regeneration reads BOTH catalog snapshots —
	// the Z.ai rows just fetched plus the hub's current OpenRouter snapshot —
	// so neither refresh can clobber the other's routes in litellm.yaml.
	const regenEnv: Record<string, string> = { ZAI_CATALOG_FILE: path };
	const openRouterPath = hub.upstreams?.openrouter_free_catalog_file;
	if (openRouterPath) regenEnv.OPENROUTER_FREE_CATALOG = openRouterPath;
	act.run([process.execPath, activation.gatewayGenerator], regenEnv);
	act.restart();
	await act.wait(snapshot.model_ids.map((id) => `zai-${id}`));
	act.run([
		process.execPath,
		join(import.meta.dir, "hubctl.ts"),
		"reload-upstreams",
		name,
	]);
	act.writeApplied(path, hash);
	return `${name}: activated ${snapshot.model_ids.length} Z.ai account routes`;
};

export async function refreshConfiguredZai(
	stack: StackConfig,
	deps: ZaiRefreshDeps = {},
): Promise<string[]> {
	const act = activationSeam(deps);
	const configured = Object.entries(stack.hubs).filter(
		([, hub]) => hub.upstreams?.zai_catalog_file,
	);
	if (configured.length === 0)
		return ["Z.ai refresh idle: no hub configures a zai catalog file"];
	const eligible = configured.filter(
		([, hub]) =>
			hub.buckle_prefs?.allow_cloud === true &&
			hub.secrets?.upstream_keys?.LITELLM_KEY,
	);
	if (eligible.length === 0)
		return [
			"Z.ai refresh idle: no hub has cloud opt-in and a LiteLLM key path",
		];
	const messages: string[] = [];
	for (const [name, hub] of eligible) {
		const path = hub.upstreams?.zai_catalog_file;
		const keyFile = hub.secrets?.upstream_keys?.Z_AI_API_KEY;
		if (!path || !keyFile) continue;
		const snapshot = await fetchZaiCatalog(keyFile, deps.fetcher);
		writeZaiSnapshot(path, snapshot);
		const hash = activation.markerHash(snapshot.model_ids);
		if (act.applied(path) === hash) {
			messages.push(`${name}: ${snapshot.model_ids.length} routes unchanged`);
			continue;
		}
		messages.push(await activateZaiHub(name, path, hub, snapshot, hash, act));
	}
	return messages;
}
