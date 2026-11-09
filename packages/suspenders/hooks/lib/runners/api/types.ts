import type { RunnerController } from "../control/controller.ts";
import type { RunnerStore } from "../control/store.ts";
import type { createExecutorBindings } from "./bindings.ts";
import type { RunnerProfile } from "./contracts.ts";
import type { RunnerIdentity } from "./identity.ts";
import type { RunnerDiagnostic } from "./diagnostics.ts";

export interface RunnerApiDependencies {
	controller: RunnerController;
	store: RunnerStore;
	identity(request: Request): Promise<RunnerIdentity>;
	bindings: ReturnType<typeof createExecutorBindings>;
	profiles: Readonly<Record<string, RunnerProfile>>;
	allowedHosts?: readonly string[];
	onDiagnostic?: (event: RunnerDiagnostic) => void;
}
export interface RunnerRequest {
	request: Request;
	identity: RunnerIdentity;
	runId: string;
	action: string;
}
