import { z } from "zod";
import type { RunnerStore } from "./store.ts";

const EventsSchema = z
	.array(
		z.object({
			id: z.number().int().positive(),
			run_id: z.uuid(),
			kind: z.string().max(200),
			payload_json: z.string().max(4096),
			created_at: z.number().int(),
		}),
	)
	.max(32);

/** Cap in SQL before allocation; malformed/oversize events fail without cursor advance. */
export function readRunnerEvents(
	store: RunnerStore,
	runId: string,
	cursor: number,
) {
	return EventsSchema.parse(
		store.all(
			`SELECT id, run_id,
    CASE WHEN length(kind) <= 200 THEN kind ELSE NULL END AS kind,
    CASE WHEN length(CAST(payload_json AS BLOB)) <= 4096
      THEN payload_json ELSE NULL END AS payload_json, created_at
    FROM runner_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 32`,
			runId,
			cursor,
		),
	);
}
