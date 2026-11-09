import { hasScope } from "@klh/buckle/src/gov/scopes.ts";
import { z } from "zod";
import { RunnerSpecSchema } from "../control/control-state.ts";
import type { RunnerStore } from "../control/store.ts";
import type { RunnerIdentity } from "./identity.ts";

const RowSchema = z.object({ spec_json: z.string().max(16_384) });
export function requireRunnerScope(identity: RunnerIdentity, write: boolean) {
	if (!hasScope(identity.scopes, `buckle:runner:${write ? "WRITE_" : "READ_"}`))
		throw new Error("runner.forbidden");
}
export function runnerActor(identity: RunnerIdentity, reader?: string) {
	const scopes = [...identity.scopes];
	if (
		hasScope(scopes, "buckle:runner:READ_") &&
		!scopes.includes("buckle:runner:READ_")
	)
		scopes.push("buckle:runner:READ_");
	return { sid: reader ?? identity.keyId, scopes };
}
export function requireRunnerOwner(
	store: RunnerStore,
	identity: RunnerIdentity,
	runId: string,
	write: boolean,
) {
	requireRunnerScope(identity, write);
	const row = RowSchema.nullable().parse(
		store.get("SELECT spec_json FROM runner_jobs WHERE run_id = ?", runId),
	);
	if (!row) throw new Error("runner.not_found");
	const spec = RunnerSpecSchema.parse(JSON.parse(row.spec_json));
	if (
		spec.owner !== identity.keyId &&
		!hasScope(identity.scopes, `buckle:admin:${write ? "WRITE_" : "READ_"}`)
	)
		throw new Error("runner.forbidden");
	return spec;
}
