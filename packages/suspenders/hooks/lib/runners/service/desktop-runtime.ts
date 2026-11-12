import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import {
	stream,
	streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { createRegistry } from "@earendil-works/pi-durable";
import { runArgv, runArgvStream } from "../desktop/spawn.ts";
import { createRemoteProcessTransport } from "../desktop/remote-process.ts";
import { createDesktopRunnerLeaf } from "../desktop/wiring.ts";
import { privateDirectory } from "../durable/private-paths.ts";
import { loadDesktopRuntimeConfig } from "./desktop-config.ts";
import {
	checkDesktopImage,
	checkDesktopMintAuthority,
	checkRunnerDockerLimits,
	runnerDockerArgv,
} from "./desktop-preflight.ts";
import type { runRunnerService } from "./process.ts";

export async function desktopRuntime(
	config: Parameters<typeof loadDesktopRuntimeConfig>[0],
	stateDir: string,
): Promise<Parameters<typeof runRunnerService>[0]> {
	const desktop = await loadDesktopRuntimeConfig(config);
	await Promise.all([
		checkDesktopImage(desktop.image),
		checkDesktopMintAuthority(desktop.baseUrl, desktop.adminKey),
		checkRunnerDockerLimits(),
	]);
	return {
		async openRuntime({ store, bindings, profiles }) {
			const workspacesDir = join(stateDir, "workspaces");
			const durableRoot = join(stateDir, "durable");
			await Promise.all([
				privateDirectory(workspacesDir),
				privateDirectory(durableRoot),
			]);
			const baseUrl = new URL("/v1", desktop.baseUrl).href;
			const { discoverRunnerModels } = await import("./model-capabilities.ts");
			const catalog = await discoverRunnerModels({
				baseUrl: desktop.baseUrl,
				adminKey: desktop.adminKey,
				profiles,
			});
			const models = createModels();
			models.setProvider(
				createProvider({
					id: "belt",
					baseUrl,
					auth: {
						apiKey: {
							name: "belt",
							resolve: async () => ({
								auth: { apiKey: "runner-leaf-credential-required" },
								source: "runner",
							}),
						},
					},
					models: catalog.models,
					api: { "openai-completions": { stream, streamSimple } },
				}),
			);
			const leaf = createDesktopRunnerLeaf({
				store,
				durableRoot,
				executorSid:
					process.platform === "linux" ? "linux-hub-runner" : "desktop-runner",
				container: {
					image: desktop.image,
					seedRoot: desktop.seedRoot,
					workspacesDir,
					runDocker: (argv, options) =>
						runArgv(runnerDockerArgv(argv), options),
					runDockerStream: (argv) => runArgvStream(runnerDockerArgv(argv)),
					dockerArgv: runnerDockerArgv,
					processTransportFactory: (record) =>
						createRemoteProcessTransport(
							{
								containerId: record.containerId,
								expectedPinnedImageRef: record.image,
								deadlineAt: record.deadlineAt,
								dockerBin: record.argv[0] ?? "docker",
							},
							{ dockerArgv: runnerDockerArgv },
						),
				},
				runtime: {
					models,
					registry: createRegistry(),
					settings: undefined,
					onReport() {},
				},
				credentials: {
					baseUrl: desktop.baseUrl,
					adminKey: desktop.adminKey,
					receiptsPath: join(stateDir, "credentials.json"),
					async onCredential({ runId, keyId, epoch, expiresAt }) {
						bindings.register({
							runId,
							keyId,
							epoch,
							expiresAt: Date.parse(expiresAt),
						});
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
