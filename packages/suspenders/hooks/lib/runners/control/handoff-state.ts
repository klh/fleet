import {
	JournalIdentitySchema,
	type JournalIdentity,
} from "../durable/journal-anchor.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunnerStore } from "./store.ts";

const HandoffRowSchema = z.object({
	run_id: z.string(),
	op_id: z.string().nullable(),
	phase: z.enum([
		"live",
		"parked",
		"failed",
		"admitting",
		"submitting",
		"parking",
		"restoring",
		"recovering",
		"activating",
		"stopping",
	]),
	expires_at: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	checkpoint_json: z.string().nullable(),
	journal_json: z.string().nullable(),
});
export type HandoffRow = z.output<typeof HandoffRowSchema>;
export type HandoffOperation = {
	runId: string;
	id: string;
	previous: HandoffRow;
	deadlineAt: number;
};

/** Durable exclusion survives HOST death. Interrupted operations refuse;
 * neither elapsed time nor a new HOST silently grants their authority. */
export function openHandoffState(store: RunnerStore) {
	store.run(`CREATE TABLE IF NOT EXISTS runner_handoffs (
 run_id TEXT PRIMARY KEY, op_id TEXT, phase TEXT NOT NULL,
 epoch INTEGER NOT NULL, checkpoint_json TEXT, expires_at INTEGER NOT NULL DEFAULT 0, journal_json TEXT)`);
	const read = (runId: string): HandoffRow | null => {
		const row = store.get(
			"SELECT * FROM runner_handoffs WHERE run_id = ?",
			runId,
		);
		return row ? HandoffRowSchema.parse(row) : null;
	};
	return {
		read,
		journal(runId: string): JournalIdentity {
			const raw = read(runId)?.journal_json;
			if (!raw)
				throw new Error("runner: recorded HOST journal identity required");
			return JournalIdentitySchema.parse(JSON.parse(raw));
		},
		pinJournal(runId: string, opId: string, identity: JournalIdentity): void {
			if (
				store.run(
					"UPDATE runner_handoffs SET journal_json = ? WHERE run_id = ? AND op_id = ? AND journal_json IS NULL",
					JSON.stringify(JournalIdentitySchema.parse(identity)),
					runId,
					opId,
				).changes !== 1
			)
				throw new Error("runner: HOST journal binding raced or already exists");
		},
		claim(
			runId: string,
			phase: HandoffRow["phase"],
			epoch: number,
		): HandoffOperation {
			store.run(
				"INSERT INTO runner_handoffs (run_id, op_id, phase, epoch, checkpoint_json) VALUES (?, NULL, 'live', ?, NULL) ON CONFLICT(run_id) DO NOTHING",
				runId,
				epoch,
			);
			const previous = read(runId);
			if (
				!previous ||
				previous.op_id ||
				!["live", "parked", "failed"].includes(previous.phase)
			)
				throw new Error("runner: handoff operation in progress or interrupted");
			const id = randomUUID(),
				deadlineAt = Date.now() + 60_000;
			const result = store.run(
				"UPDATE runner_handoffs SET op_id = ?, phase = ?, epoch = ?, expires_at = ? WHERE run_id = ? AND op_id IS NULL AND phase = ? AND epoch = ?",
				id,
				phase,
				epoch,
				deadlineAt,
				runId,
				previous.phase,
				previous.epoch,
			);
			if (result.changes !== 1)
				throw new Error("runner: handoff operation raced");
			return { runId, id, previous, deadlineAt };
		},
		assertOwned(op: HandoffOperation, allowExpired = false): void {
			if (
				(!allowExpired && Date.now() >= op.deadlineAt) ||
				read(op.runId)?.op_id !== op.id
			)
				throw new Error("runner: handoff operation lost");
		},
		finish(
			op: HandoffOperation,
			phase: "live" | "parked" | "failed",
			epoch: number,
			checkpoint = op.previous.checkpoint_json,
		): void {
			if (phase !== "failed" && Date.now() >= op.deadlineAt)
				throw new Error("runner: handoff operation expired");
			const result = store.run(
				"UPDATE runner_handoffs SET op_id = NULL, phase = ?, epoch = ?, checkpoint_json = ? WHERE run_id = ? AND op_id = ?",
				phase,
				epoch,
				checkpoint,
				op.runId,
				op.id,
			);
			if (result.changes !== 1)
				throw new Error("runner: stale handoff completion");
		},
		fence(
			runId: string,
			epoch: number,
			operationId?: string,
			action = "execute",
		): void {
			const row = read(runId);
			if (!row) return;
			if (row.op_id && row.expires_at <= Date.now())
				throw new Error("runner: handoff operation expired");
			const live =
				row.phase === "live" ||
				row.phase === "submitting" ||
				row.phase === "admitting";
			const ownRestore =
				row.phase === "restoring" &&
				row.op_id === operationId &&
				action === "open";
			const ownRecovery =
				row.phase === "recovering" && row.op_id === operationId;
			const activating =
				row.phase === "activating" && row.op_id === operationId;
			if (
				(!live && !ownRestore && !ownRecovery && !activating) ||
				row.epoch !== epoch
			)
				throw new Error("runner: execution closed by handoff");
		},
		activate(op: HandoffOperation): void {
			if (
				store.run(
					"UPDATE runner_handoffs SET phase = 'activating' WHERE run_id = ? AND op_id = ? AND phase = 'restoring'",
					op.runId,
					op.id,
				).changes !== 1
			)
				throw new Error("runner: restore commit lost");
		},
		bindEpoch(op: HandoffOperation, epoch: number): void {
			if (
				store.run(
					"UPDATE runner_handoffs SET epoch = ? WHERE run_id = ? AND op_id = ?",
					epoch,
					op.runId,
					op.id,
				).changes !== 1
			)
				throw new Error("runner: handoff operation lost");
		},
	};
}
