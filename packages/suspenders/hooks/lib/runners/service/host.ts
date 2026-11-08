import { createExecutorBindings } from "../api/bindings.ts";
import { openRunnerListener } from "../api/listener.ts";
import type { RunnerApiDependencies } from "../api/types.ts";
import { readRunnerProfiles } from "./profiles.ts";
import { openRunnerState } from "./state.ts";

type Runtime = Pick<RunnerApiDependencies, "controller"> & {
	controller: RunnerApiDependencies["controller"];
	close(): Promise<void>;
};

export async function openRunnerHost(
	options: Pick<RunnerApiDependencies, "identity"> & {
		stateDir: string;
		profilesFile: string;
		port: number;
		identity: RunnerApiDependencies["identity"];
		openRuntime(
			deps: Pick<RunnerApiDependencies, "store" | "bindings" | "profiles">,
		): Promise<Runtime>;
	},
) {
	const profiles = readRunnerProfiles(options.profilesFile);
	const state = await openRunnerState(options.stateDir);
	let runtime: Runtime | undefined;
	try {
		const deps = {
			store: state.store,
			profiles,
			bindings: createExecutorBindings({ store: state.store }),
		};
		const opened = await options.openRuntime(deps);
		runtime = opened;
		const listener = openRunnerListener({
			...deps,
			controller: opened.controller,
			port: options.port,
			identity: options.identity,
		});
		let stopped: Promise<void> | undefined;
		return {
			url: listener.url,
			stop: () =>
				(stopped ??= (async () => {
					await listener.stop();
					try {
						await opened.close();
					} finally {
						await state.close();
					}
				})()),
		};
	} catch (error) {
		try {
			await runtime?.close();
		} finally {
			await state.close();
		}
		throw error;
	}
}
