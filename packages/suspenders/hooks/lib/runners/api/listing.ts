import { hasScope } from "@klh/buckle/src/gov/scopes.ts";
import { z } from "zod";
import { RunnerSpecSchema } from "../control/control-state.ts";
import { DEFAULT_LEASE_TTL_MS } from "../control/controller.ts";
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

/** This listener reports only its own fresh, owner-visible runners. */
export function listRunnerWorkers(
	store: RunnerStore,
	identity: RunnerIdentity,
	now = Date.now(),
) {
	requireRunnerScope(identity, false);
	const cutoff = now - DEFAULT_LEASE_TTL_MS;
	const admin = hasScope(identity.scopes, "buckle:admin:READ_");
	const rows = store.all<{ run_id: string; state: string }>(
		`SELECT h.run_id, j.state FROM runner_worker_heartbeats h
		 JOIN runner_leases l ON l.run_id = h.run_id
		  AND l.controller_sid = h.controller_sid AND l.epoch = h.epoch
		 JOIN runner_jobs j ON j.run_id = h.run_id
		 WHERE l.state = 'active' AND l.updated_at >= ? AND h.updated_at >= ?
		  AND j.state IN ('running', 'parked')
		  AND (? = 1 OR json_extract(j.spec_json, '$.owner') = ?)
		 ORDER BY h.updated_at DESC, h.run_id LIMIT 100`,
		cutoff,
		cutoff,
		admin ? 1 : 0,
		identity.keyId,
	);
	return {
		workers: rows.map(({ run_id, state }) => ({
			sid: run_id,
			name: null,
			class: "remote",
			origin: { kind: "runner", id: run_id },
			compute: null,
			inference: [],
			owner_sid: null,
			rights: ["read-only"],
			state,
			task: null,
			activity: [],
			reported_by: "runner",
		})),
		asOf: now,
		errors: [],
	};
}
