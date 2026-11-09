// Controller state wraps the canonical immutable durable job schema.
import { createHash } from "node:crypto";
import { z } from "zod";
import { JobSpecSchema as RunnerSpecSchema } from "../durable/contracts.ts";
import { JobStateSchema } from "./lifecycle.ts";

export type RunnerSpec = z.infer<typeof RunnerSpecSchema>;

/** The controller's per-job closure state row (keyed by runId; generation
 *  mirrors the admitted spec and is NEVER bumped here — a new generation
 *  is a new admission, per root #117690). */
export const ControlJobSchema = z
	.object({
		runId: z.uuid(),
		generation: z.number().int().positive(),
		state: JobStateSchema,
		/** auto-park default: the controller parks on inactivity. */
		auto_park: z.boolean().default(true),
		/** interrupts received while parked/holding — stay visible. */
		held_interrupts: z.array(z.string().min(1)).default([]),
		/** event id the first attach replays from (since-last committed). */
		cursor_base: z.number().int().min(0).default(0),
		created_at: z.number().int().positive(),
		updated_at: z.number().int().positive(),
	})
	.strict();

export type ControlJob = z.infer<typeof ControlJobSchema>;

/** sha256 hex of anything stringable — how the controller mints digests
 *  (node:crypto, no Bun globals: the runner witness runs under real
 *  Node). */
export const digestOf = (input: string | Uint8Array): string =>
	createHash("sha256").update(input).digest("hex");

export { RunnerSpecSchema };
