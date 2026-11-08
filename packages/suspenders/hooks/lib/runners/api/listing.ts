import { hasScope } from "@klh/buckle/src/gov/scopes.ts";
import { z } from "zod";
import { RunnerSpecSchema } from "../control/control-state.ts";
import { JobStateSchema } from "../control/lifecycle.ts";
import type { RunnerStore } from "../control/store.ts";
import type { RunnerIdentity } from "./identity.ts";
import { requireRunnerScope } from "./rights.ts";

const RowsSchema = z
	.array(
		z.object({
			run_id: z.uuid(),
			spec_json: z.string().max(16_384),
			state: JobStateSchema,
			updated_at: z.number().int(),
		}),
	)
	.max(101);
export function listRunnerJobs(
	store: RunnerStore,
	identity: RunnerIdentity,
	after?: string,
) {
	requireRunnerScope(identity, false);
	const cursor = after === undefined ? "" : z.uuid().parse(after);
	const admin = hasScope(identity.scopes, "buckle:admin:READ_");
	const rows = RowsSchema.parse(
		store.all(
			`SELECT run_id, spec_json, state, updated_at
    FROM runner_jobs WHERE run_id > ? AND (? = 1 OR json_extract(spec_json, '$.owner') = ?)
    ORDER BY run_id LIMIT 101`,
			cursor,
			admin ? 1 : 0,
			identity.keyId,
		),
	);
	return {
		runs: rows.slice(0, 100).map((row) => {
			const spec = RunnerSpecSchema.parse(JSON.parse(row.spec_json));
			return {
				runId: spec.runId,
				owner: spec.owner,
				generation: spec.generation,
				kind: spec.kind,
				model: spec.model,
				provider: spec.provider,
				state: row.state,
				updatedAt: row.updated_at,
			};
		}),
		nextCursor: rows.length > 100 ? rows[99].run_id : null,
	};
}
