import { createHash } from "node:crypto";
import {
	EmptySchema,
	RunnerReaderSchema,
	RunnerSubmitSchema,
} from "./contracts.ts";
import { runnerActor } from "./rights.ts";
import type { RunnerApiDependencies, RunnerRequest } from "./types.ts";
import { readWireJson } from "./wire.ts";

export async function runnerAction(
	deps: RunnerApiDependencies,
	input: RunnerRequest,
) {
	const { request, identity, runId, action } = input;
	const actor = runnerActor(identity);
	const body = await readWireJson(request);
	if (action === "submit") {
		const value = RunnerSubmitSchema.parse(body);
		return deps.controller.submit({ runId, actor, ...value });
	}
	if (["attach", "replay", "detach"].includes(action)) {
		const { readerId } = RunnerReaderSchema.parse(body);
		actor.sid = `reader:${createHash("sha256").update(`${identity.keyId}\0${readerId}`).digest("hex")}`;
		if (action === "attach") return deps.controller.attach({ runId, actor });
		if (action === "replay") return deps.controller.replay({ runId, actor });
		await deps.controller.detach({ runId, actor });
		return { ok: true };
	}
	EmptySchema.parse(body);
	if (action === "resume") return deps.controller.resume({ runId, actor });
	if (action === "park") return deps.controller.park({ runId, actor });
	if (action === "abort")
		return deps.controller.stopWithRevocation({ runId, actor });
	throw new Error("runner.not_found");
}
