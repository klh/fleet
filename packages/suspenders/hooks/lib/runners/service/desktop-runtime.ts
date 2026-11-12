import { join } from "node:path";
import { runArgv, runArgvStream } from "../desktop/spawn.ts";
import { createDesktopRunnerLeaf } from "../desktop/wiring.ts";
import { privateDirectory } from "../durable/private-paths.ts";
import { loadDesktopRuntimeConfig } from "./desktop-config.ts";
import {
	checkDesktopImage,
	checkDesktopMintAuthority,
	checkRunnerDockerLimits,
	runnerDockerArgv,
} from "./desktop-preflight.ts";
import { beltLeafRuntime } from "./belt-models.ts";
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
			const modelIds = new Set(
				Object.values(profiles).map((profile) => {
					if (profile.provider !== "belt")
						throw new Error("runner.unsupported_provider");
					return profile.model;
				}),
			);
			const runtime = beltLeafRuntime(desktop.baseUrl, [...modelIds]);
			const models = runtime.models;
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
				},
				runtime,
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
