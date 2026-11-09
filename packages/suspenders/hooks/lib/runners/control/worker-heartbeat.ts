import { z } from "zod";
import type { RunnerStore } from "./store.ts";

const IdentitySchema = z.object({
	runId: z.uuid(),
	controllerSid: z.string().min(1).max(200),
	epoch: z.number().int().positive(),
});

export const WorkerHeartbeatSchema = z.strictObject({
	state: z.enum(["running", "waiting", "parked"]),
});

export type WorkerHeartbeatIdentity = z.infer<typeof IdentitySchema>;

export function ensureWorkerHeartbeatSchema(store: RunnerStore): void {
	store.run(`CREATE TABLE IF NOT EXISTS runner_worker_heartbeats (
		run_id TEXT PRIMARY KEY,
		controller_sid TEXT NOT NULL,
		epoch INTEGER NOT NULL,
		state TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`);
}

/** The caller resolves identity from a trusted controller binding, never JSON. */
export function recordWorkerHeartbeat(
	store: RunnerStore,
	identity: WorkerHeartbeatIdentity,
	body: unknown,
	now: number,
	freshAfter: number,
): boolean {
	const { runId, controllerSid, epoch } = IdentitySchema.parse(identity);
	const { state } = WorkerHeartbeatSchema.parse(body);
	const result = store.run(
		`INSERT INTO runner_worker_heartbeats (run_id, controller_sid, epoch, state, updated_at)
		SELECT run_id, controller_sid, epoch, ?, ? FROM runner_leases
		WHERE run_id = ? AND controller_sid = ? AND epoch = ?
		  AND state = 'active' AND updated_at >= ?
		ON CONFLICT(run_id) DO UPDATE SET
		  controller_sid = excluded.controller_sid,
		  epoch = excluded.epoch,
		  state = excluded.state,
		  updated_at = excluded.updated_at
		WHERE excluded.epoch > runner_worker_heartbeats.epoch
		   OR (excluded.epoch = runner_worker_heartbeats.epoch
		       AND excluded.updated_at >= runner_worker_heartbeats.updated_at)`,
		state,
		now,
		runId,
		controllerSid,
		epoch,
		freshAfter,
	);
	return result.changes === 1;
}
