// lifecycle.ts — W2869.2: the job state machine (pure). States ride the
// durable contract (root #117690/#117699): a job is OPENED cold, SUBMIT
// starts the first execution, RESUME restarts from parked/cold, ABORT is
// the only path into stopping; auto-park is the default (job-spec.ts) so
// the controller parks on inactivity — interrupts arriving while parked
// stay HELD and visible (held_interrupts), never silently dropped. Every
// transition is asserted against the table — an illegal transition fails
// loud instead of wedging a job into an undefined state.
import { z } from "zod";

export const JobStateSchema = z.enum([
	"cold",
	"running",
	"parked",
	"stopping",
	"stopped",
	"failed",
]);
export type JobState = z.infer<typeof JobStateSchema>;

/** Legal transitions. stopped/failed are terminal (retry = a new job;
 *  supersede owns history). resume from cold covers the SIGKILL-recovery
 *  cold start (root W2869.1: reopen resumes the same job). */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
	cold: ["running", "parked", "stopping"],
	running: ["parked", "stopping"],
	parked: ["running", "stopping"],
	stopping: ["stopped", "failed"],
	stopped: [],
	failed: [],
};

/** True when from→to is legal. */
export const canTransition = (from: JobState, to: JobState): boolean =>
	TRANSITIONS[from].includes(to);

/** Assert a transition; throws a loud, state-bearing error when illegal —
 *  the controller refuses the action BEFORE touching any store row. */
export function assertTransition(from: JobState, to: JobState): void {
	if (canTransition(from, to)) return;
	throw new Error(
		`runner: illegal lifecycle transition ${from} → ${to} (legal from ${from}: ${TRANSITIONS[from].join(", ") || "terminal"})`,
	);
}

/** Which control actions are meaningful from a state — the CLI/adapter
 *  layer renders refusals from this, never invents fake success. */
export const ACTIONS_FROM: Readonly<Record<JobState, readonly string[]>> = {
	cold: ["submit", "resume", "abort", "read", "attach"],
	running: ["park", "abort", "read", "attach", "steer"],
	parked: ["submit", "resume", "abort", "read", "attach"],
	stopping: ["read"],
	stopped: ["read"],
	failed: ["read"],
};
