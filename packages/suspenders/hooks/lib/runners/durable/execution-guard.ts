import {
	createRegistry,
	defineExtension,
	type HarnessOptions,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { Authorize, JobSpec } from "./contracts.ts";
import { fencedModels } from "./fenced-models.ts";

/** Pin registry publication for this job; enforce host policy at each native boundary. */
export function executionGuard(
	runtime: Pick<HarnessOptions, "registry" | "models">,
	authorize: Authorize,
	spec: JobSpec,
) {
	const registry = createRegistry();
	for (const extension of runtime.registry.snapshot().installed()) {
		if (extension.name === "fleet-execution-guard")
			throw new Error("Reserved Fleet execution guard name");
		registry.install(extension);
	}
	const guard = defineExtension({
		name: "fleet-execution-guard",
		hooks: [
			hook(ToolTask, {
				async beforeTool() {
					await authorize("execute", spec);
				},
			}),
		],
	});
	registry.install(guard);
	return {
		registry,
		guard,
		models: () =>
			fencedModels(
				typeof runtime.models === "function"
					? runtime.models()
					: runtime.models,
				authorize,
				spec,
			),
	};
}
