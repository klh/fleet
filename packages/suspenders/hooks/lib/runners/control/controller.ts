// controller.ts — W2869.2: the runner control plane. Admission parses
// the durable spec ONCE (identity is immutable — root #117690), takes
// the distributed lease, and writes the control row; every later action
// re-authorizes against the 6-action vocabulary BEFORE touching a row.
// The executor adapter is optional by construction: without one, start-
// shaped actions refuse honestly (executor-absent) instead of faking
// success — read/abort still govern the control row. The watchdog closes
// the loop the poll cannot (root #117701): lease flip → abort signal →
// revokeCredential backstop → stopping.
import { z } from "zod";
import { assertTransition, type JobState } from "./lifecycle.ts";
import {
	ControlJobSchema,
	RunnerSpecSchema,
	type ControlJob,
	type RunnerSpec,
} from "./control-state.ts";
import {
	admitLease,
	ensureRunnerLeaseSchema,
	getLease,
	revokeLease,
	type LeaseToken,
} from "./leases.ts";
import {
	attachReader,
	detachReader,
	ensureRunnerReaderSchema,
	recordRunnerEvent,
	replayReader,
	type RunnerEvent,
} from "./cursors.ts";
import {
	makeRunnerAuthorizer,
	type RunnerActor,
	type RunnerAuthorizer,
} from "./rights.ts";
import type { RunnerStore } from "./store.ts";

const JOBS_DDL = `
CREATE TABLE IF NOT EXISTS runner_jobs (
	run_id TEXT PRIMARY KEY,
	spec_json TEXT NOT NULL,
	generation INTEGER NOT NULL,
	state TEXT NOT NULL,
	auto_park INTEGER NOT NULL DEFAULT 1,
	held_interrupts_json TEXT NOT NULL DEFAULT '[]',
	cursor_base INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`;

const JobRowSchema = z.object({
	run_id: z.string(),
	spec_json: z.string(),
	generation: z.number().int(),
	state: z.string(),
	auto_park: z.number().int(),
	held_interrupts_json: z.string(),
	cursor_base: z.number().int(),
	created_at: z.number().int(),
	updated_at: z.number().int(),
});

type JobRow = z.infer<typeof JobRowSchema>;

export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface DurableAdapter {
	start(spec: RunnerSpec, opts: { signal: AbortSignal }): Promise<void>;
	submit(runId: string, text: string): Promise<void>;
	resume(runId: string): Promise<void>;
	stop(runId: string): Promise<void>;
}

export type ActionResult =
	| { ok: true; state: JobState }
	| { ok: false; reason: string };

/** The controller face: authorize-then-mutate on every action, honest
 *  refusals when no executor is bound, and the revoke-stop watchdog. */
export interface RunnerController {
	admit(input: {
		spec: RunnerSpec;
		actor: RunnerActor;
		autoPark?: boolean;
	}): Promise<{ token: LeaseToken }>;
	submit(input: {
		runId: string;
		text: string;
		actor: RunnerActor;
	}): Promise<ActionResult>;
	resume(input: { runId: string; actor: RunnerActor }): Promise<ActionResult>;
	park(input: { runId: string; actor: RunnerActor }): Promise<ActionResult>;
	abort(input: { runId: string; actor: RunnerActor }): Promise<ActionResult>;
	/** Executor-side fence before every fetch and tool boundary. Throws
	 *  RunnerAuthError when the lease no longer holds. */
	fence(input: { runId: string; actor: RunnerActor }): Promise<void>;
	read(input: {
		runId: string;
		actor: RunnerActor;
		since?: number;
	}): Promise<{ job: ControlJob; events: RunnerEvent[] }>;
	attach(input: {
		runId: string;
		readerSid: string;
		actor: RunnerActor;
	}): Promise<{ cursor: number; events: RunnerEvent[] }>;
	replay(input: {
		runId: string;
		readerSid: string;
		actor: RunnerActor;
	}): Promise<{ cursor: number; events: RunnerEvent[] }>;
	detach(input: {
		runId: string;
		readerSid: string;
		actor: RunnerActor;
	}): Promise<void>;
	/** The manual revoke-stop: abort + lease revoke + credential backstop. */
	stopWithRevocation(input: {
		runId: string;
		actor: RunnerActor;
	}): Promise<ActionResult>;
	/** Poll the lease; on loss: abort + revokeCredential + stopping. */
	watch(input: { runId: string; intervalMs: number }): { stop(): void };
}

export const openRunnerController = (deps: {
	store: RunnerStore;
	durable?: DurableAdapter | null;
	revokeCredential?: (runId: string) => Promise<void>;
	authorizer?: RunnerAuthorizer;
	now?: () => number;
	leaseTtlMs?: number;
}): RunnerController => {
	const now = deps.now ?? (() => Date.now());
	const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	deps.store.run(JOBS_DDL);
	ensureRunnerLeaseSchema(deps.store);
	ensureRunnerReaderSchema(deps.store);
	const authorizer =
		deps.authorizer ?? makeRunnerAuthorizer({ store: deps.store, now });
	const signals = new Map<string, AbortController>();

	const jobRow = (runId: string): JobRow | null =>
		deps.store.get<JobRow>("SELECT * FROM runner_jobs WHERE run_id = ?", runId);

	const toControlJob = (row: JobRow): ControlJob =>
		ControlJobSchema.parse({
			runId: row.run_id,
			generation: row.generation,
			state: row.state,
			auto_park: row.auto_park === 1,
			held_interrupts: JSON.parse(row.held_interrupts_json) as string[],
			cursor_base: row.cursor_base,
			created_at: row.created_at,
			updated_at: row.updated_at,
		});

	const setState = (runId: string, state: JobState, at: number): void => {
		deps.store.run(
			"UPDATE runner_jobs SET state = ?, updated_at = ? WHERE run_id = ?",
			state,
			at,
			runId,
		);
	};

	const record = (runId: string, kind: string, payload: unknown): void => {
		recordRunnerEvent(deps.store, { runId, kind, payload, now: now() });
	};

	const specOf = (row: JobRow): RunnerSpec =>
		RunnerSpecSchema.parse(JSON.parse(row.spec_json));

	return {
		async admit({ spec, actor, autoPark }) {
			await authorizer.authorize("open", { runId: spec.runId, actor });
			const parsed = RunnerSpecSchema.parse(spec);
			const at = now();
			const lease = admitLease(deps.store, {
				runId: parsed.runId,
				controllerSid: actor.sid,
				now: at,
				ttlMs,
			});
			if (!lease.ok) throw new Error(lease.reason);
			deps.store.run(
				`INSERT INTO runner_jobs (run_id, spec_json, generation, state, auto_park, held_interrupts_json, cursor_base, created_at, updated_at)
				 VALUES (?, ?, ?, 'cold', ?, '[]', 0, ?, ?)`,
				parsed.runId,
				JSON.stringify(parsed),
				parsed.generation,
				autoPark === false ? 0 : 1,
				at,
				at,
			);
			recordRunnerEvent(deps.store, {
				runId: parsed.runId,
				kind: "admitted",
				payload: {
					generation: parsed.generation,
					owner: parsed.owner,
					controller: actor.sid,
				},
				now: at,
			});
			return { token: lease.token };
		},
		async submit({ runId, text, actor }) {
			await authorizer.authorize("submit", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			if (state === "cold") {
				if (!deps.durable) {
					return {
						ok: false,
						reason: "executor-absent: no durable adapter bound — control row unchanged",
					};
				}
				const controller = new AbortController();
				signals.set(runId, controller);
				await deps.durable.start(specOf(row), { signal: controller.signal });
				setState(runId, "running", now());
				record(runId, "started", { by: actor.sid });
				return { ok: true, state: "running" };
			}
			if (state === "parked") {
				const held = JSON.parse(row.held_interrupts_json) as string[];
				held.push(text);
				deps.store.run(
					"UPDATE runner_jobs SET held_interrupts_json = ?, updated_at = ? WHERE run_id = ?",
					JSON.stringify(held),
					now(),
					runId,
				);
				record(runId, "held-interrupt", { by: actor.sid, chars: text.length });
				return { ok: true, state: "parked" };
			}
			return {
				ok: false,
				reason: `runner: submit from ${state} refuses (cold/parked/running)`,
			};
		},
		async resume({ runId, actor }) {
			await authorizer.authorize("resume", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			if (state !== "cold" && state !== "parked") {
				return {
					ok: false,
					reason: `runner: resume from ${state} refuses (cold/parked only)`,
				};
			}
			if (!deps.durable) {
				return {
					ok: false,
					reason: "executor-absent: cannot resume without a durable adapter",
				};
			}
			await deps.durable.resume(runId);
			setState(runId, "running", now());
			record(runId, "resumed", { by: actor.sid });
			return { ok: true, state: "running" };
		},
		async park({ runId, actor }) {
			await authorizer.authorize("abort", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			if (state !== "running" && state !== "cold") {
				return {
					ok: false,
					reason: `runner: park from ${state} refuses (running/cold only)`,
				};
			}
			if (deps.durable) {
				return {
					ok: false,
					reason:
						"runner: park is runtime-owned when an executor is bound (auto_park) — use abort",
				};
			}
			assertTransition(state, "parked");
			setState(runId, "parked", now());
			record(runId, "parked", { by: actor.sid });
			return { ok: true, state: "parked" };
		},
		async abort({ runId, actor }) {
			await authorizer.authorize("abort", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			assertTransition(state, "stopping");
			if (deps.durable) await deps.durable.stop(runId);
			signals.get(runId)?.abort();
			signals.delete(runId);
			setState(runId, "stopping", now());
			record(runId, "abort", { by: actor.sid });
			return { ok: true, state: "stopping" };
		},
		async fence({ runId, actor }) {
			await authorizer.authorize("execute", { runId, actor });
		},
		async read({ runId, actor, since }) {
			await authorizer.authorize("read", { runId, actor });
			const row = jobRow(runId);
			if (!row) throw new Error("runner: unknown run");
			const events = deps.store.all<RunnerEvent>(
				"SELECT * FROM runner_events WHERE run_id = ? AND id > ? ORDER BY id",
				runId,
				since ?? row.cursor_base,
			);
			return { job: toControlJob(row), events };
		},
		async attach({ runId, readerSid, actor }) {
			await authorizer.authorize("read", { runId, actor });
			const row = jobRow(runId);
			if (!row) throw new Error("runner: unknown run");
			return attachReader(deps.store, {
				runId,
				readerSid,
				fromCursor: row.cursor_base,
				now: now(),
			});
		},
		async replay({ runId, readerSid, actor }) {
			await authorizer.authorize("read", { runId, actor });
			return replayReader(deps.store, {
				runId,
				readerSid,
				now: now(),
			});
		},
		async detach({ runId, readerSid, actor }) {
			await authorizer.authorize("read", { runId, actor });
			detachReader(deps.store, { runId, readerSid, now: now() });
		},
		async stopWithRevocation({ runId, actor }) {
			await authorizer.authorize("abort", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			assertTransition(state, "stopping");
			if (deps.durable) await deps.durable.stop(runId);
			signals.get(runId)?.abort();
			signals.delete(runId);
			const revoked = revokeLease(deps.store, runId, now());
			if (deps.revokeCredential) await deps.revokeCredential(runId);
			setState(runId, "stopping", now());
			record(runId, "abort", {
				by: actor.sid,
				leaseRevoked: revoked.ok,
				credentialRevoked: Boolean(deps.revokeCredential),
			});
			return { ok: true, state: "stopping" };
		},
		watch({ runId, intervalMs }) {
			let timer: ReturnType<typeof setInterval> | null = null;
			let fired = false;
			const halt = async (): Promise<void> => {
				if (fired) return;
				fired = true;
				if (timer) clearInterval(timer);
				timer = null;
				signals.get(runId)?.abort();
				signals.delete(runId);
				if (deps.durable) await deps.durable.stop(runId);
				if (deps.revokeCredential) await deps.revokeCredential(runId);
				const row = jobRow(runId);
				if (!row) return;
				const state = toControlJob(row).state;
				if (state === "running" || state === "cold" || state === "parked") {
					setState(runId, "stopping", now());
				}
				record(runId, "fence-revoked", {
					watchdog: true,
					credentialRevoked: Boolean(deps.revokeCredential),
				});
			};
			timer = setInterval(() => {
				const lease = getLease(deps.store, runId);
				if (lease && lease.state === "active") return;
				void halt();
			}, intervalMs);
			return {
				stop(): void {
					if (timer) clearInterval(timer);
					timer = null;
					fired = true;
				},
			};
		},
	};
};