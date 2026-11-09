// leases.ts — W2869.2: the distributed lease + fencing-token plane (root
// #117690: the kernel's port-based writer exclusion is NOT a distributed
// lease — the Fleet controller fences remote job admission). One row per
// admitted run. Admission is a CAS INSERT: two controllers can never both
// hold epoch 1. Revoke flips state AND bumps the epoch, so every in-flight
// executor token of the old epoch fences on its very next check. Takeover
// (crashed controller past ttl, or a revoked run re-admitted as a new
// generation) re-enters only through admitLease, always epoch+1. A
// successful fenceCheck doubles as the executor heartbeat.
import type { RunnerStore } from "./store.ts";

const LEASES_DDL = `
CREATE TABLE IF NOT EXISTS runner_leases (
	run_id TEXT PRIMARY KEY,
	controller_sid TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('active','revoked')),
	updated_at INTEGER NOT NULL
)`;

export interface LeaseToken {
	readonly epoch: number;
}

export interface LeaseRow {
	run_id: string;
	controller_sid: string;
	epoch: number;
	state: "active" | "revoked";
	updated_at: number;
}

export type FenceVerdict = { ok: true } | { ok: false; reason: string };
export type AdmitVerdict =
	| { ok: true; token: LeaseToken }
	| { ok: false; reason: string };

export const ensureRunnerLeaseSchema = (store: RunnerStore): void => {
	store.run(LEASES_DDL);
};

export const getLease = (store: RunnerStore, runId: string): LeaseRow | null =>
	store.get<LeaseRow>("SELECT * FROM runner_leases WHERE run_id = ?", runId);

/** CAS admission. Fresh run inserts epoch 1 atomically; an existing lease
 *  re-admits only when it is stale past ttlMs (crashed controller) or
 *  revoked (new generation) — either takeover bumps the epoch. */
export function admitLease(
	store: RunnerStore,
	input: { runId: string; controllerSid: string; now: number; ttlMs: number },
): AdmitVerdict {
	const fresh = store.run(
		`INSERT INTO runner_leases (run_id, controller_sid, epoch, state, updated_at)
		 VALUES (?, ?, 1, 'active', ?)
		 ON CONFLICT(run_id) DO NOTHING`,
		input.runId,
		input.controllerSid,
		input.now,
	);
	if (fresh.changes === 1) return { ok: true, token: { epoch: 1 } };
	const row = getLease(store, input.runId);
	if (!row)
		return { ok: false, reason: "runner: lease row vanished mid-admission" };
	const staleAt = input.now - input.ttlMs;
	if (row.state === "active" && row.updated_at > staleAt) {
		return {
			ok: false,
			reason: `runner: lease held by ${row.controller_sid} (epoch ${row.epoch}, fresh)`,
		};
	}
	const took = store.run(
		`UPDATE runner_leases SET controller_sid = ?, epoch = epoch + 1, state = 'active', updated_at = ?
		 WHERE run_id = ? AND epoch = ? AND (state = 'revoked' OR updated_at <= ?)`,
		input.controllerSid,
		input.now,
		input.runId,
		row.epoch,
		staleAt,
	);
	if (took.changes !== 1)
		return {
			ok: false,
			reason: "runner: lease takeover raced another controller",
		};
	return { ok: true, token: { epoch: row.epoch + 1 } };
}

/** The fence every executor-side action rides (root #117705: a lease
 *  check before every actual fetch and tool boundary). ok = the token's
 *  epoch IS the live active epoch. The check renews updated_at, so a
 *  live executor never expires its own lease out from under itself. */
export function fenceCheck(
	store: RunnerStore,
	runId: string,
	token: LeaseToken,
	now: number,
): FenceVerdict {
	const row = getLease(store, runId);
	if (!row) return { ok: false, reason: "runner: no lease for this run" };
	if (row.state !== "active")
		return { ok: false, reason: "runner: lease revoked" };
	if (row.epoch !== token.epoch) {
		return {
			ok: false,
			reason: `runner: fenced — live epoch ${row.epoch} ≠ token epoch ${token.epoch}`,
		};
	}
	const renewed = store.run(
		"UPDATE runner_leases SET updated_at = ? WHERE run_id = ? AND epoch = ? AND state = 'active'",
		now,
		runId,
		token.epoch,
	);
	if (renewed.changes !== 1) {
		return { ok: false, reason: "runner: fenced — lease changed mid-check" };
	}
	return { ok: true };
}

/** Controller-side revoke: state flip + epoch bump in one CAS. Any
 *  executor still holding the old epoch fences on its next check. */
export function revokeLease(
	store: RunnerStore,
	runId: string,
	now: number,
): FenceVerdict {
	const row = getLease(store, runId);
	if (row?.state !== "active") {
		return { ok: false, reason: "runner: no active lease to revoke" };
	}
	const flipped = store.run(
		`UPDATE runner_leases SET state = 'revoked', epoch = epoch + 1, updated_at = ?
		 WHERE run_id = ? AND epoch = ? AND state = 'active'`,
		now,
		runId,
		row.epoch,
	);
	if (flipped.changes !== 1)
		return { ok: false, reason: "runner: revoke raced another controller" };
	return { ok: true };
}
