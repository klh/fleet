import { z } from "zod";
import type { RunnerStore } from "../control/store.ts";

const BindingSchema = z.strictObject({
	keyId: z.string().min(1).max(200),
	runId: z.uuid(),
	epoch: z.number().int().positive(),
	expiresAt: z.number().int().positive(),
});
const RowSchema = z.strictObject({
	run_id: z.uuid(),
	epoch: z.number().int().positive(),
	expires_at: z.number().int().positive(),
});

/** Host-only registration. This object must never be an HTTP mutation route. */
export function createExecutorBindings(deps: {
	store: RunnerStore;
	now?: () => number;
}) {
	const now = deps.now ?? Date.now;
	deps.store.run(`CREATE TABLE IF NOT EXISTS runner_executor_bindings (
    key_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    expires_at INTEGER NOT NULL)`);
	const row = (keyId: string) =>
		RowSchema.nullable().parse(
			deps.store.get(
				"SELECT run_id, epoch, expires_at FROM runner_executor_bindings WHERE key_id = ?",
				keyId,
			),
		);
	return {
		register(input: unknown) {
			const value = BindingSchema.parse(input);
			if (value.expiresAt <= now()) throw new Error("runner.invalid_expiry");
			deps.store.run(
				`INSERT INTO runner_executor_bindings (key_id, run_id, epoch, expires_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(key_id) DO NOTHING`,
				value.keyId,
				value.runId,
				value.epoch,
				value.expiresAt,
			);
			const saved = row(value.keyId);
			if (
				!saved ||
				saved.run_id !== value.runId ||
				saved.epoch !== value.epoch ||
				saved.expires_at !== value.expiresAt
			)
				throw new Error("runner.binding_conflict");
		},
		resolve(keyId: string, runId: string) {
			const saved = row(keyId);
			if (!saved || saved.run_id !== runId || saved.expires_at <= now())
				throw new Error("runner.forbidden");
			return { epoch: saved.epoch };
		},
	};
}
