import { z } from "zod";
import {
	fingerprintClosedJournal,
	JournalAnchorSchema,
} from "../durable/journal-anchor.ts";
import { join } from "node:path";
import type {
	openHandoffState,
	HandoffOperation,
} from "../control/handoff-state.ts";
import { admitLease, getLease, type LeaseToken } from "../control/leases.ts";
import { RunnerSpecSchema, type RunnerSpec } from "../control/control-state.ts";
import type { RunnerStore } from "../control/store.ts";
import type { CredentialManager } from "./credentials.ts";
import type {
	DesktopContainer,
	DesktopExecutorDeps,
} from "./docker-executor.ts";
import type { openDurableJob } from "../durable/job.ts";
import { privateDirectory } from "../durable/private-paths.ts";
import {
	captureWorkspace,
	restoreWorkspace,
	validateWorkspaceFile,
} from "./workspace-transfer.ts";
import {
	openWorkspaceCheckpoint,
	WorkspaceCheckpointSchema,
} from "./workspace-checkpoint.ts";

const ParkedReceiptSchema = z.strictObject({
	checkpoint: WorkspaceCheckpointSchema,
	journal: JournalAnchorSchema,
});

type Job = Awaited<ReturnType<typeof openDurableJob>>;
export type OwnedExecution = {
	epoch: number;
	executor: DesktopContainer;
	job?: Job;
};
type Handoffs = ReturnType<typeof openHandoffState>;

/** This coordinator receives only HOST-owned handles. Every destructive
 * closure keeps its own epoch and executor rather than consulting a map. */
export function createLeafHandoff(deps: {
	store: RunnerStore;
	durableRoot: string;
	container: DesktopExecutorDeps;
	credentials: CredentialManager;
	handoffs: Handoffs;
	executorSid: string;
	ttlMs: number;
	execution(runId: string): OwnedExecution | undefined;
	open(
		spec: RunnerSpec,
		token: LeaseToken,
		op: HandoffOperation,
		executor: DesktopContainer,
	): Promise<Job>;
	fresh(runId: string, epoch: number): DesktopContainer;
	install(runId: string, execution: OwnedExecution): void;
	detach(runId: string): void;
	stopTimers(runId: string): void;
	arm(runId: string, token: LeaseToken): void;
}) {
	const checkpointRoot = join(deps.durableRoot, ".checkpoints");
	const maxBytes = deps.container.artifactCapBytes ?? 32 * 1024 * 1024;
	const readSpec = (runId: string) =>
		RunnerSpecSchema.parse(
			JSON.parse(
				deps.store.get<{ spec_json: string }>(
					"SELECT spec_json FROM runner_jobs WHERE run_id = ?",
					runId,
				)?.spec_json ?? "",
			),
		);
	const fenceCaptured = (runId: string, epoch: number) => {
		const changed = deps.store.run(
			"UPDATE runner_leases SET state = 'revoked', epoch = epoch + 1, updated_at = ? WHERE run_id = ? AND epoch = ? AND state = 'active'",
			Date.now(),
			runId,
			epoch,
		);
		if (changed.changes !== 1)
			throw new Error("runner: captured lease changed during handoff");
	};
	const setJobState = (op: HandoffOperation, state: string) => {
		deps.handoffs.assertOwned(op, state === "failed");
		if (
			deps.store.run(
				"UPDATE runner_jobs SET state = ?, updated_at = ? WHERE run_id = ? AND EXISTS (SELECT 1 FROM runner_handoffs WHERE run_id = ? AND op_id = ?)",
				state,
				Date.now(),
				op.runId,
				op.runId,
				op.id,
			).changes !== 1
		)
			throw new Error("runner: handoff state commit failed");
	};
	const bounded = async <T>(
		run: () => Promise<T>,
		timeoutMs: number,
		label: string,
	): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				run(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`runner: ${label} timed out`)),
						Math.max(1, timeoutMs),
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const cleanup = async (
		runId: string,
		execution: OwnedExecution,
		errors: unknown[],
	) => {
		deps.stopTimers(runId);
		let jobClosed = false;
		try {
			await bounded(
				async () => {
					await execution.job?.close();
				},
				5_000,
				"journal close",
			);
			jobClosed = true;
		} catch (error) {
			errors.push(error);
		}
		for (const step of [
			() => deps.credentials.revoke(runId, execution.epoch),
			() => execution.executor.stop(runId),
		]) {
			try {
				await bounded(step, 15_000, "owned cleanup");
			} catch (error) {
				errors.push(error);
			}
		}
		// Keep the executor/CID/epoch banked even when cleanup fails. A retry
		// addresses this exact handle; no newer execution is selected.
		if (jobClosed) deps.detach(runId);
	};
	return {
		async retryCleanup(runId: string): Promise<void> {
			const previous = deps.handoffs.read(runId),
				execution = deps.execution(runId);
			if (
				previous?.phase !== "failed" ||
				!execution ||
				execution.epoch !== previous.epoch
			)
				throw new Error("runner: no owned failed execution cleanup");
			const op = deps.handoffs.claim(runId, "stopping", execution.epoch);
			const errors: unknown[] = [];
			await cleanup(runId, execution, errors);
			deps.handoffs.finish(op, "failed", execution.epoch);
			if (errors.length)
				throw new AggregateError(
					errors,
					"runner: owned cleanup remains uncertain",
				);
		},
		async park(runId: string, token: LeaseToken): Promise<void> {
			const execution = deps.execution(runId);
			if (!execution?.job || execution.epoch !== token.epoch)
				throw new Error("runner: no owned live execution to park");
			const op = deps.handoffs.claim(runId, "parking", token.epoch);
			try {
				// SDK close preserves pending work and releases the HOST journal writer.
				await bounded(
					() => execution.job?.close() ?? Promise.resolve(),
					op.deadlineAt - Date.now(),
					"park journal close",
				);
				const journal = await fingerprintClosedJournal(deps.durableRoot, runId);
				if (
					JSON.stringify(journal.manifest) !==
					JSON.stringify(execution.job.manifest)
				)
					throw new Error("runner: HOST manifest changed while parking");
				const record = await bounded(
					() => execution.executor.quiesce(runId),
					op.deadlineAt - Date.now(),
					"park quiescence",
				);
				if (record.deadlineAt === undefined)
					throw new Error("checkpoint: missing original deadline");
				await privateDirectory(checkpointRoot);
				const checkpoint = await captureWorkspace({
					deps: deps.container,
					record,
					root: checkpointRoot,
					maxBytes,
					operationDeadlineAt: op.deadlineAt,
					binding: {
						job: execution.job.manifest,
						image: record.image,
						deadlineAt: record.deadlineAt,
						leaseEpoch: execution.epoch,
						conversationId: String(execution.job.conversationId),
					},
				});
				deps.handoffs.assertOwned(op);
				deps.stopTimers(runId);
				fenceCaptured(runId, token.epoch);
				// Key death is awaited; a pending or failed revoke is never PARKED.
				await deps.credentials.revoke(runId, token.epoch);
				await execution.executor.stop(runId);
				deps.detach(runId);
				setJobState(op, "parked");
				deps.handoffs.finish(
					op,
					"parked",
					token.epoch,
					JSON.stringify({ checkpoint, journal: journal.anchor }),
				);
			} catch (error) {
				const errors: unknown[] = [error];
				const lease = getLease(deps.store, runId);
				if (lease?.epoch === token.epoch && lease.state === "active") {
					try {
						fenceCaptured(runId, token.epoch);
					} catch (failure) {
						errors.push(failure);
					}
				}
				await cleanup(runId, execution, errors);
				setJobState(op, "failed");
				deps.handoffs.finish(op, "failed", token.epoch, null);
				throw new AggregateError(
					errors,
					"runner: park failed; execution destroyed",
				);
			}
		},
		async restore(runId: string, activate: () => Promise<void>): Promise<void> {
			const previous = deps.handoffs.read(runId);
			if (previous?.phase !== "parked" || !previous.checkpoint_json)
				throw new Error("runner: no committed parked checkpoint");
			const op = deps.handoffs.claim(runId, "restoring", previous.epoch);
			let execution: OwnedExecution | undefined;
			let newEpoch: number | undefined;
			let fileClosed = false;
			let opened:
				| Awaited<ReturnType<typeof openWorkspaceCheckpoint>>
				| undefined;
			try {
				const receipt = ParkedReceiptSchema.parse(
					JSON.parse(previous.checkpoint_json),
				);
				const checkpoint = receipt.checkpoint;
				const journal = await fingerprintClosedJournal(deps.durableRoot, runId);
				if (
					JSON.stringify(journal.anchor) !== JSON.stringify(receipt.journal) ||
					JSON.stringify(journal.manifest) !==
						JSON.stringify(checkpoint.binding.job)
				)
					throw new Error("runner: HOST journal history changed or missing");
				const spec = readSpec(runId);
				if (
					JSON.stringify(checkpoint.binding.job.spec) !==
						JSON.stringify(spec) ||
					checkpoint.binding.image !== deps.container.image
				)
					throw new Error("checkpoint: immutable spec or image drift");
				opened = await openWorkspaceCheckpoint({
					root: checkpointRoot,
					id: checkpoint.id,
					expected: checkpoint.binding,
					maxBytes,
				});
				await validateWorkspaceFile(opened.file, maxBytes);
				deps.handoffs.assertOwned(op);
				// Even a restarted manager must confirm the exact old key's death.
				await deps.credentials.revoke(runId, checkpoint.binding.leaseEpoch);
				const admitted = admitLease(deps.store, {
					runId,
					controllerSid: deps.executorSid,
					now: Date.now(),
					ttlMs: deps.ttlMs,
				});
				if (!admitted.ok) throw new Error(admitted.reason);
				if (admitted.token.epoch <= checkpoint.binding.leaseEpoch)
					throw new Error("runner: restore requires newer authority");
				newEpoch = admitted.token.epoch;
				deps.handoffs.bindEpoch(op, admitted.token.epoch);
				const executor = deps.fresh(runId, admitted.token.epoch);
				execution = { epoch: admitted.token.epoch, executor };
				deps.install(runId, execution);
				await executor.restore(spec, {
					signal: new AbortController().signal,
					deadlineAt: checkpoint.binding.deadlineAt,
				});
				const record = executor.runRecord(runId);
				if (!record)
					throw new Error("checkpoint: restore guest identity missing");
				await restoreWorkspace({
					deps: deps.container,
					record,
					file: opened.file,
					maxBytes,
					operationDeadlineAt: op.deadlineAt,
				});
				await opened.file.close();
				fileClosed = true;
				const job = await deps.open(spec, admitted.token, op, executor);
				execution.job = job;
				if (
					String(job.conversationId) !== checkpoint.binding.conversationId ||
					JSON.stringify(job.manifest) !==
						JSON.stringify(checkpoint.binding.job)
				)
					throw new Error("checkpoint: HOST journal identity changed");
				await deps.credentials.ensure(runId, admitted.token.epoch);
				deps.handoffs.assertOwned(op);
				deps.install(runId, execution);
				// The new execution identity is persisted before scheduling. The op
				// remains exclusive until controller.resume drains held request IDs.
				deps.handoffs.activate(op);
				await activate();
				deps.handoffs.finish(
					op,
					"live",
					admitted.token.epoch,
					previous.checkpoint_json,
				);
				deps.arm(runId, admitted.token);
			} catch (error) {
				const errors: unknown[] = [error];
				if (!execution && newEpoch !== undefined) {
					const lease = getLease(deps.store, runId);
					if (lease?.epoch === newEpoch && lease.state === "active") {
						try {
							fenceCaptured(runId, newEpoch);
						} catch (failure) {
							errors.push(failure);
						}
					}
				}
				if (execution) {
					const lease = getLease(deps.store, runId);
					if (lease?.epoch === execution.epoch && lease.state === "active") {
						try {
							fenceCaptured(runId, execution.epoch);
						} catch (failure) {
							errors.push(failure);
						}
					}
					await cleanup(runId, execution, errors);
				}
				setJobState(op, "failed");
				deps.handoffs.finish(
					op,
					"failed",
					execution?.epoch ?? previous.epoch,
					previous.checkpoint_json,
				);
				throw new AggregateError(
					errors,
					"runner: restore refused; cleanup receipts attached",
				);
			} finally {
				if (opened && !fileClosed) await opened.file.close();
			}
		},
	};
}
