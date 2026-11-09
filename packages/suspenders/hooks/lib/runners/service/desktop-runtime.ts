import { createModels, createProvider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createRegistry } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { createDesktopRunnerLeaf } from "../desktop/wiring.ts";
import { privateDirectory } from "../durable/private-paths.ts";
import { loadDesktopRuntimeConfig } from "./desktop-config.ts";
import { checkDesktopImage, checkDesktopMintAuthority } from "./desktop-preflight.ts";
import type { runRunnerService } from "./process.ts";

export async function desktopRuntime(
	config: Parameters<typeof loadDesktopRuntimeConfig>[0],
	stateDir: string,
): Promise<Parameters<typeof runRunnerService>[0]> {
	const desktop = await loadDesktopRuntimeConfig(config);
	await Promise.all([
		checkDesktopImage(desktop.image),
		checkDesktopMintAuthority(desktop.baseUrl, desktop.adminKey),
	]);
	return {
		async openRuntime({ store, bindings, profiles }) {
			const workspacesDir = join(stateDir, "workspaces");
			const durableRoot = join(stateDir, "durable");
			await Promise.all([privateDirectory(workspacesDir), privateDirectory(durableRoot)]);
			const baseUrl = new URL("/v1", desktop.baseUrl).href;
			const modelIds = new Set(Object.values(profiles).map(profile => {
				if (profile.provider !== "belt") throw new Error("runner.unsupported_provider");
				return profile.model;
			}));
			const models = createModels();
			models.setProvider(createProvider({
				id: "belt", baseUrl,
				auth: { apiKey: { name: "belt", resolve: async () => ({
					auth: { apiKey: "runner-leaf-credential-required" }, source: "runner",
				}) } },
				models: [...modelIds].map(id => ({
					id, name: id, api: "openai-completions", provider: "belt", baseUrl,
					input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					reasoning: false, contextWindow: 32_768, maxTokens: 2_048,
				})),
				api: { "openai-completions": { stream, streamSimple } },
			}));
			const leaf = createDesktopRunnerLeaf({
				store, durableRoot, executorSid: "desktop-runner", cleanupTimeoutMs: 20_000,
				container: { image: desktop.image, seedRoot: desktop.seedRoot, workspacesDir },
				runtime: { models, registry: createRegistry(), settings: undefined, onReport() {} },
				credentials: {
					baseUrl: desktop.baseUrl, adminKey: desktop.adminKey,
					receiptsPath: join(stateDir, "credentials.json"),
					async onCredential({ runId, keyId, epoch, expiresAt }) {
						bindings.register({ runId, keyId, epoch, expiresAt: Date.parse(expiresAt) });
					},
				},
			});
			try {
				const recovery = await leaf.recover();
				if (recovery.refused.length) throw new Error("runner.recovery_refused");
				return leaf;
			} catch (error) {
				await leaf.close();
				throw error;
			}
		},
	};
}
