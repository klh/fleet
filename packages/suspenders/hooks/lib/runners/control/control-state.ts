// control-state.ts — W2869.2: the controller's job identity + control-row
// shapes. RunnerSpecSchema is a byte-for-byte mirror of the W2869.1 durable
// contract (hooks/lib/runners/durable/contracts.ts JobSpecSchema — root
// #117690/#117699): the controller validates the spec at admission and
// NEVER rewrites it; swapping to the real import happens the moment
// suspenders/W2869.1 lands (delete this mirror, import from ../durable/).
// ControlJobSchema is the controller's OWN closure state around that
// immutable spec: lifecycle state, auto-park, held interrupts, cursor
// base — separate from the manifest, never merged into it. .strict()
// everywhere: malformed shapes fail loud at admission, not mid-flight.
import { createHash } from "node:crypto";
import { z } from "zod";
import { JobStateSchema } from "./lifecycle.ts";

const DIGEST = /^[a-f0-9]{64}$/;

/** Durable spec boundary (mirror of W2869.1 JobSpecSchema v1). */
export const RunnerSpecSchema = z.strictObject({
	version: z.literal(1),
	runId: z.uuid(),
	owner: z.string().min(1).max(200),
	generation: z.number().int().positive(),
	kind: z.enum(["coding", "design", "knowledge"]),
	seedDigest: z.string().regex(DIGEST),
	policyDigest: z.string().regex(DIGEST),
	provider: z.string().min(1).max(120),
	model: z.string().min(1).max(200),
});

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
