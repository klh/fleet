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
import {
	type ControlJob,
	ControlJobSchema,
	type RunnerSpec,
	RunnerSpecSchema,
} from "./control-state.ts";
import {
	attachReader,
	detachReader,
	ensureRunnerReaderSchema,
	type RunnerEvent,
	recordRunnerEvent,
	replayReader,
} from "./cursors.ts";
import { readRunnerEvents } from "./feed.ts";
import {
	admitLease,
	ensureRunnerLeaseSchema,
	getLease,
	type LeaseToken,
	revokeLease,
} from "./leases.ts";
import { assertTransition, type JobState } from "./lifecycle.ts";
import {
	makeRunnerAuthorizer,
	type RunnerActor,
	type RunnerAuthorizer,
} from "./rights.ts";
import type { RunnerStore } from "./store.ts";
import { heldSubmissions, RunnerSubmissionSchema } from "./submissions.ts";
import { ensureWorkerHeartbeatSchema } from "./worker-heartbeat.ts";

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
	executorStopTimeoutMs?: number;
}): RunnerController => {
	const now = deps.now ?? (() => Date.now());
	const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? 5_000;
	deps.store.run(JOBS_DDL);
	ensureRunnerLeaseSchema(deps.store);
	ensureWorkerHeartbeatSchema(deps.store);
	ensureRunnerReaderSchema(deps.store);
	// Recover only completed cleanups whose receipt is newer than both the
	// stopping transition and the current revoked lease. A later generation,
	// incomplete cleanup, or a legacy unfenced abort cannot satisfy this.
	if (deps.durable && deps.revokeCredential)
		deps.store.run(
			`UPDATE runner_jobs AS job SET state = 'stopped', updated_at = ?
			 WHERE job.state = 'stopping' AND EXISTS (
			   SELECT 1 FROM runner_leases AS lease
			   JOIN runner_events AS event ON event.run_id = lease.run_id
			   WHERE lease.run_id = job.run_id AND lease.state = 'revoked'
			     AND event.kind = 'abort'
			     AND event.created_at >= MAX(job.updated_at, lease.updated_at)
			     AND event.id = (
			       SELECT MAX(id) FROM runner_events
			       WHERE run_id = job.run_id AND kind = 'abort'
			     )
			     AND json_extract(event.payload_json, '$.leaseRevoked') = 1
			     AND json_extract(event.payload_json, '$.credentialRevoked') = 1
			     AND json_type(event.payload_json, '$.cleanupErrors') = 'array'
			     AND json_array_length(event.payload_json, '$.cleanupErrors') = 0
			 )`,
			now(),
		);
	const authorizer =
		deps.authorizer ?? makeRunnerAuthorizer({ store: deps.store, now });
	const signals = new Map<string, AbortController>();
	const resuming = new Set<string>();
	/** One independent cleanup step, bounded: resolves null on success, a
	 *  recorded error string on throw OR timeout — the revocation ladder
	 *  never awaits an unbounded executor stop. */
	const bounded = (
		run: () => Promise<void>,
		label: string,
		timeoutMs = cleanupTimeoutMs,
	): Promise<string | null> => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve(`${label} timed out`), timeoutMs);
		});
		const done = (async () => run())().then(
			() => null,
			() => `${label} failed`,
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

	const finalizeStop = (
		runId: string,
		fencedEpoch: number | undefined,
		cleanupErrors: string[],
	): "stopped" | "failed" | "stopping" => {
		const state = cleanupErrors.length ? "failed" : "stopped";
		const updated = deps.store.run(
			`UPDATE runner_jobs SET state = ?, updated_at = ?
			 WHERE run_id = ? AND state = 'stopping'
			   AND NOT EXISTS (
			     SELECT 1 FROM runner_leases WHERE run_id = ?
			       AND (state = 'active' OR epoch <> ?)
			   )`,
			state,
			now(),
			runId,
			runId,
			fencedEpoch ?? 0,
		);
		return updated.changes === 1 ? state : "stopping";
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
			const held = getLease(deps.store, parsed.runId);
			if (boundSpec && actor.leaseToken && held?.controller_sid === actor.sid) {
				await authorizer.authorize("execute", { runId: parsed.runId, actor });
				return { token: actor.leaseToken };
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
			if (resuming.has(runId))
				return { ok: false, reason: "runner: resume in progress" };
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
				if (signals.has(runId))
					return { ok: false, reason: "runner: start already in progress" };
				const controller = new AbortController();
				signals.set(runId, controller);
				try {
					await deps.durable.start(specOf(row), { signal: controller.signal });
					controller.signal.throwIfAborted();
					await deps.durable.submit(runId, text, {
						requestId: submission.requestId,
					});
					controller.signal.throwIfAborted();
				} catch (error) {
					if (signals.get(runId) === controller) signals.delete(runId);
					if (controller.signal.aborted)
						return { ok: false, reason: "runner: start aborted" };
					throw error;
				}
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
			if (resuming.has(runId) || (state === "cold" && signals.has(runId)))
				return { ok: false, reason: "runner: startup in progress" };
			resuming.add(runId);
			try {
				await deps.durable.resume(runId);
				if (jobRow(runId)?.state !== state)
					return { ok: false, reason: "runner: resume interrupted" };
				const held = heldSubmissions(row.held_interrupts_json);
				const drained = new Set<number>();
				const drainErrors: string[] = [];
				for (const [index, submission] of held.entries()) {
					try {
						await deps.durable.submit(runId, submission.text, {
							requestId: submission.requestId,
						});
						drained.add(index);
					} catch {
						drainErrors.push("submission delivery failed");
					}
					if (jobRow(runId)?.state !== state)
						return { ok: false, reason: "runner: resume interrupted" };
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
			} finally {
				resuming.delete(runId);
			}
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
			if (
				state === "stopped" &&
				getLease(deps.store, runId)?.state !== "active"
			)
				return { ok: true, state };
			assertTransition(state, "stopping");
			// Fence FIRST: authorization dies before any cleanup runs; every
			// later step is independent + bounded with errors recorded.
			const leaseRow = getLease(deps.store, runId);
			const revoked = revokeLease(deps.store, runId, now());
			const fenced = getLease(deps.store, runId);
			if (fenced?.state === "active")
				return { ok: false, reason: "runner: lease changed during stop" };
			setState(runId, "stopping", now());
			signals.get(runId)?.abort();
			signals.delete(runId);
			const cleanupErrors: string[] = [];

			if (deps.revokeCredential) {
				const err = await bounded(
					async () =>
						deps.revokeCredential?.(runId, {
							epoch: leaseRow?.epoch ?? 0,
							controllerSid: leaseRow?.controller_sid ?? actor.sid,
						}),
					"credential revoke",
				);

				if (err) cleanupErrors.push(err);
			}
			if (
				deps.durable &&
				getLease(deps.store, runId)?.epoch === fenced?.epoch
			) {
				const err = await bounded(
					async () => deps.durable?.stop(runId),
					"executor stop",
					deps.executorStopTimeoutMs,
				);
				if (err) cleanupErrors.push(err);
			}
			record(runId, "abort", {
				by: actor.sid,
				leaseRevoked: revoked.ok,
				credentialRevoked:
					Boolean(deps.revokeCredential) &&
					!cleanupErrors.some((error) =>
						error.startsWith("credential revoke "),
					),
				cleanupErrors,
			});
			return {
				ok: true,
				state: finalizeStop(runId, fenced?.epoch, cleanupErrors),
			};
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
				const row = jobRow(runId);
				if (!row) return;
				const state = toControlJob(row).state;
				if (state === "stopping" || state === "stopped" || state === "failed")
					return;
				const current = getLease(deps.store, runId);
				const takenOver =
					current !== null &&
					(current.controller_sid !== captured.controller_sid ||
						current.epoch !==
							captured.epoch + (current.state === "revoked" ? 1 : 0));
				if (!takenOver) {
					if (current?.state === "active")
						revokeLease(deps.store, runId, now());
					setState(runId, "stopping", now());
					signals.get(runId)?.abort();
					signals.delete(runId);
				}
				const fencedEpoch = getLease(deps.store, runId)?.epoch;
				const cleanupErrors: string[] = [];
				if (deps.revokeCredential) {
					const err = await bounded(
						async () =>
							deps.revokeCredential?.(runId, {
								epoch: captured.epoch,
								controllerSid: captured.controller_sid,
							}),
						"credential revoke",
					);
					if (err) cleanupErrors.push(err);
				}
				if (
					!takenOver &&
					deps.durable &&
					getLease(deps.store, runId)?.epoch === fencedEpoch
				) {
					const err = await bounded(
						async () => deps.durable?.stop(runId),
						"executor stop",
						deps.executorStopTimeoutMs,
					);
					if (err) cleanupErrors.push(err);
				}
				if (!takenOver) finalizeStop(runId, fencedEpoch, cleanupErrors);
				record(runId, "fence-revoked", {
					watchdog: true,
					epoch: captured.epoch,
					credentialRevoked:
						Boolean(deps.revokeCredential) &&
						!cleanupErrors.some((error) =>
							error.startsWith("credential revoke "),
						),
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
