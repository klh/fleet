// Fleet-loop's config-gated refresh. The applied marker advances only after
// LiteLLM and Buckle accept the new model list; failed activation retries.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StackConfig } from "../hooks/lib/stack-config.ts";
import { fetchFreeSnapshot, writeFreeSnapshot } from "./openrouter-free.ts";
import * as activation from "./litellm-activation.ts";

const home = process.env.HOME ?? homedir();
const keyFile = join(home, ".claude/local-llm/openrouter.key");

const keyFileReady = (): boolean => {
	try {
		const key = statSync(keyFile);
		return key.isFile() && (key.mode & 0o777) === 0o600 && key.size > 0;
	} catch {
		return false;
	}
};

export async function refreshConfiguredOpenRouter(
	stack: StackConfig,
): Promise<string[]> {
	const configured = Object.entries(stack.hubs).filter(
		([, hub]) => hub.upstreams?.openrouter_free_catalog_file,
	);
	if (configured.length === 0) return [];
	if (!keyFileReady())
		return ["OpenRouter refresh idle: inference key missing or not mode 0600"];
	const eligible = configured.filter(
		([, hub]) =>
			hub.buckle_prefs?.allow_cloud === true &&
			hub.secrets?.upstream_keys?.LITELLM_KEY,
	);
	if (eligible.length === 0)
		return [
			"OpenRouter refresh idle: no hub has cloud opt-in and a LiteLLM key path",
		];
	const snapshot = await fetchFreeSnapshot();
	const hash = activation.markerHash(snapshot.groups);
	const messages: string[] = [];
	for (const [name, hub] of eligible) {
		const path = hub.upstreams?.openrouter_free_catalog_file;
		if (!path) continue;
		writeFreeSnapshot(path, snapshot);
		if (activation.appliedHash(path) === hash) {
			messages.push(
				`${name}: ${Object.keys(snapshot.groups).length} routes unchanged`,
			);
			continue;
		}
		if (process.platform !== "darwin" || hub.deploy?.ssh)
			throw new Error(
				`${name}: automatic LiteLLM reload currently requires a local macOS hub`,
			);
		activation.runCommand([process.execPath, activation.gatewayGenerator], {
			OPENROUTER_FREE_CATALOG: path,
		});
		activation.restartLiteLLM();
		await activation.waitForLiteLLMModels(Object.keys(snapshot.groups));
		activation.runCommand([
			process.execPath,
			join(import.meta.dir, "hubctl.ts"),
			"reload-upstreams",
			name,
		]);
		activation.writeAppliedHash(path, hash);
		messages.push(
			`${name}: activated ${Object.keys(snapshot.groups).length} OpenRouter free routes`,
		);
	}
	return messages;
}
