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
import { heldSubmissions, RunnerSubmissionSchema } from "./submissions.ts";
import { readRunnerEvents } from "./feed.ts";

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
	submit(
		runId: string,
		text: string,
		meta?: { requestId?: string },
	): Promise<void>;
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
		requestId?: string;
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
		actor: RunnerActor;
	}): Promise<{ cursor: number; events: RunnerEvent[] }>;
	replay(input: {
		runId: string;
		actor: RunnerActor;
	}): Promise<{ cursor: number; events: RunnerEvent[] }>;
	detach(input: { runId: string; actor: RunnerActor }): Promise<void>;
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
	/** Per-generation: the host closure resolves (runId, epoch) to the
	 *  credential minted for THAT lease generation — a stale watchdog
	 *  revokes the old executor's key, never the takeover winner's. */
	revokeCredential?: (
		runId: string,
		lease: { epoch: number; controllerSid: string },
	) => Promise<void>;
	authorizer?: RunnerAuthorizer;
	now?: () => number;
	leaseTtlMs?: number;
	/** Bound each independent cleanup step so a hung executor stop cannot
	 *  strand the revocation ladder. */
	cleanupTimeoutMs?: number;
}): RunnerController => {
	const now = deps.now ?? (() => Date.now());
	const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? 5_000;
	deps.store.run(JOBS_DDL);
	ensureRunnerLeaseSchema(deps.store);
	ensureRunnerReaderSchema(deps.store);
	const authorizer =
		deps.authorizer ?? makeRunnerAuthorizer({ store: deps.store, now });
	const signals = new Map<string, AbortController>();
	/** One independent cleanup step, bounded: resolves null on success, a
	 *  recorded error string on throw OR timeout — the revocation ladder
	 *  never awaits an unbounded executor stop. */
	const bounded = (p: Promise<void>, label: string): Promise<string | null> => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve(`${label} timed out`), cleanupTimeoutMs);
		});
		const done = p.then(
			() => null,
			(err) => (err instanceof Error ? err.message : String(err)),
		);
		return Promise.race([done, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};

	const jobRow = (runId: string): JobRow | null =>
		deps.store.get<JobRow>("SELECT * FROM runner_jobs WHERE run_id = ?", runId);

	const toControlJob = (row: JobRow): ControlJob =>
		ControlJobSchema.parse({
			runId: row.run_id,
			generation: row.generation,
			state: row.state,
			auto_park: row.auto_park === 1,
			held_interrupts: heldSubmissions(row.held_interrupts_json).map(
				(value) => value.text,
			),
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
			const existing = jobRow(parsed.runId);
			const boundSpec = existing
				? RunnerSpecSchema.parse(JSON.parse(existing.spec_json))
				: null;
			if (boundSpec && JSON.stringify(boundSpec) !== JSON.stringify(parsed)) {
				throw new Error(
					"runner: run is bound to a different immutable spec — a new generation is a new runId",
				);
			}
			const lease = admitLease(deps.store, {
				runId: parsed.runId,
				controllerSid: actor.sid,
				now: at,
				ttlMs,
			});
			if (!lease.ok) throw new Error(lease.reason);
			if (boundSpec) {
				recordRunnerEvent(deps.store, {
					runId: parsed.runId,
					kind: "readmitted",
					payload: { controller: actor.sid, epoch: lease.token.epoch },
					now: at,
				});
				return { token: lease.token };
			}
			const inserted = deps.store.run(
				`INSERT INTO runner_jobs (run_id, spec_json, generation, state, auto_park, held_interrupts_json, cursor_base, created_at, updated_at)
				 VALUES (?, ?, ?, 'cold', ?, '[]', 0, ?, ?)
				 ON CONFLICT(run_id) DO NOTHING`,
				parsed.runId,
				JSON.stringify(parsed),
				parsed.generation,
				autoPark === false ? 0 : 1,
				at,
				at,
			);
			if (inserted.changes === 0) {
				const raced = jobRow(parsed.runId);
				const racedSpec = raced
					? RunnerSpecSchema.parse(JSON.parse(raced.spec_json))
					: null;
				if (
					!racedSpec ||
					JSON.stringify(racedSpec) !== JSON.stringify(parsed)
				) {
					revokeLease(deps.store, parsed.runId, at);
					throw new Error(
						"runner: concurrent admission bound a different spec — lease released",
					);
				}
				recordRunnerEvent(deps.store, {
					runId: parsed.runId,
					kind: "readmitted",
					payload: { controller: actor.sid, epoch: lease.token.epoch },
					now: at,
				});
				return { token: lease.token };
			}
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
		async submit({ runId, text, requestId, actor }) {
			await authorizer.authorize("submit", { runId, actor });
			const submission = RunnerSubmissionSchema.parse({ text, requestId });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			if (state === "cold") {
				if (!deps.durable) {
					return {
						ok: false,
						reason:
							"executor-absent: no durable adapter bound — control row unchanged",
					};
				}
				const controller = new AbortController();
				signals.set(runId, controller);
				await deps.durable.start(specOf(row), { signal: controller.signal });
				await deps.durable.submit(runId, text, {
					requestId: submission.requestId,
				});
				setState(runId, "running", now());
				record(runId, "started", { by: actor.sid });
				return { ok: true, state: "running" };
			}
			if (state === "parked") {
				const held = heldSubmissions(row.held_interrupts_json);
				if (requestId && held.some((value) => value.requestId === requestId)) {
					if (
						held.some(
							(value) => value.requestId === requestId && value.text !== text,
						)
					)
						throw new Error("runner.request_conflict");
					return { ok: true, state: "parked" };
				}
				held.push(submission);
				deps.store.run(
					"UPDATE runner_jobs SET held_interrupts_json = ?, updated_at = ? WHERE run_id = ?",
					JSON.stringify(held),
					now(),
					runId,
				);
				record(runId, "held-interrupt", { by: actor.sid, chars: text.length });
				return { ok: true, state: "parked" };
			}
			if (state === "running") {
				if (!deps.durable) {
					return {
						ok: false,
						reason: "executor-absent: cannot deliver without a durable adapter",
					};
				}
				await deps.durable.submit(runId, text, {
					requestId: submission.requestId,
				});
				record(runId, "submitted", { by: actor.sid, chars: text.length });
				return { ok: true, state: "running" };
			}
			return {
				ok: false,
				reason: `runner: submit from ${state} refuses`,
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
			const held = heldSubmissions(row.held_interrupts_json);
			const drained = new Set<number>();
			const drainErrors: string[] = [];
			for (const [index, submission] of held.entries()) {
				try {
					await deps.durable.submit(runId, submission.text, {
						requestId: submission.requestId,
					});
					drained.add(index);
				} catch (err) {
					drainErrors.push(err instanceof Error ? err.message : String(err));
				}
			}
			deps.store.run(
				"UPDATE runner_jobs SET held_interrupts_json = ?, updated_at = ? WHERE run_id = ?",
				JSON.stringify(held.filter((_, index) => !drained.has(index))),
				now(),
				runId,
			);
			setState(runId, "running", now());
			record(runId, "resumed", {
				by: actor.sid,
				drained: drained.size,
				errors: drainErrors,
			});
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
			const events = readRunnerEvents(
				deps.store,
				runId,
				since ?? row.cursor_base,
			);
			return { job: toControlJob(row), events };
		},
		async attach({ runId, actor }) {
			await authorizer.authorize("read", { runId, actor });
			const row = jobRow(runId);
			if (!row) throw new Error("runner: unknown run");
			return attachReader(deps.store, {
				runId,
				readerSid: actor.sid,
				fromCursor: row.cursor_base,
				now: now(),
			});
		},
		async replay({ runId, actor }) {
			await authorizer.authorize("read", { runId, actor });
			return replayReader(deps.store, {
				runId,
				readerSid: actor.sid,
				now: now(),
			});
		},
		async detach({ runId, actor }) {
			await authorizer.authorize("read", { runId, actor });
			detachReader(deps.store, { runId, readerSid: actor.sid, now: now() });
		},
		async stopWithRevocation({ runId, actor }) {
			await authorizer.authorize("abort", { runId, actor });
			const row = jobRow(runId);
			if (!row) return { ok: false, reason: "runner: unknown run" };
			const state = toControlJob(row).state;
			assertTransition(state, "stopping");
			// Fence FIRST: authorization dies before any cleanup runs; every
			// later step is independent + bounded with errors recorded.
			const leaseRow = getLease(deps.store, runId);
			const revoked = revokeLease(deps.store, runId, now());
			signals.get(runId)?.abort();
			signals.delete(runId);
			const cleanupErrors: string[] = [];
			if (deps.revokeCredential) {
				const err = await bounded(
					deps.revokeCredential(runId, {
						epoch: leaseRow?.epoch ?? 0,
						controllerSid: leaseRow?.controller_sid ?? actor.sid,
					}),
					"credential revoke",
				);
				if (err) cleanupErrors.push(err);
			}
			if (deps.durable) {
				const err = await bounded(deps.durable.stop(runId), "executor stop");
				if (err) cleanupErrors.push(err);
			}
			setState(runId, "stopping", now());
			record(runId, "abort", {
				by: actor.sid,
				leaseRevoked: revoked.ok,
				credentialRevoked: Boolean(deps.revokeCredential),
				cleanupErrors,
			});
			return { ok: true, state: "stopping" };
		},
		watch({ runId, intervalMs }) {
			let timer: ReturnType<typeof setInterval> | null = null;
			let fired = false;
			// The watchdog owns ONE lease generation (#117780): capture the
			// epoch at watch time; a takeover winner's row is never touched.
			const captured = getLease(deps.store, runId);
			if (!captured) throw new Error("runner: no lease to watch");
			const halt = async (): Promise<void> => {
				if (fired) return;
				fired = true;
				if (timer) clearInterval(timer);
				timer = null;
				signals.get(runId)?.abort();
				signals.delete(runId);
				const cleanupErrors: string[] = [];
				if (deps.revokeCredential) {
					const err = await bounded(
						deps.revokeCredential(runId, {
							epoch: captured.epoch,
							controllerSid: captured.controller_sid,
						}),
						"credential revoke",
					);
					if (err) cleanupErrors.push(err);
				}
				if (deps.durable) {
					const err = await bounded(deps.durable.stop(runId), "executor stop");
					if (err) cleanupErrors.push(err);
				}
				const row = jobRow(runId);
				if (!row) return;
				const taken = getLease(deps.store, runId);
				const state = toControlJob(row).state;
				const takenOver =
					taken?.state === "active" && taken.epoch !== captured.epoch;
				const ownLoss =
					!takenOver &&
					(state === "running" || state === "cold" || state === "parked");
				if (ownLoss) {
					setState(runId, "stopping", now());
				}
				record(runId, "fence-revoked", {
					watchdog: true,
					epoch: captured.epoch,
					credentialRevoked: Boolean(deps.revokeCredential),
					cleanupErrors,
				});
			};
			timer = setInterval(() => {
				const lease = getLease(deps.store, runId);
				const live =
					lease !== null &&
					lease.state === "active" &&
					lease.epoch === captured.epoch &&
					lease.updated_at > now() - ttlMs;
				if (live) return;
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
