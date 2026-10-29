// distill/lease.ts — one distiller per hub. The controller-fence pattern
// (scripts/lib/controller-fence.ts) applied to knowledge.db: a single lease
// row records the holder's host + pid + process birth; a second instance
// standbys while the holder is alive OR its liveness is unknown (cross-host,
// unreadable), and takes over only a PROVABLY dead holder — inside one
// transaction, so two racers elect exactly one. Same nonce = renew.
import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { controllerHolderLiveness } from "../../../../scripts/lib/controller-fence.ts";
import {
	type ProcessBirth,
	processBirth,
} from "../../../../scripts/lib/launch-fencing.ts";

export interface DistillLease {
	nonce: string;
	host: string;
	pid: number;
	birth: string;
	started_at: number;
	renewed_at: number;
}

export const observeLease = (db: Database): DistillLease | null =>
	(db
		.query(
			"SELECT nonce, host, pid, birth, started_at, renewed_at FROM distill_lease WHERE id = 1",
		)
		.get() as DistillLease | null) ?? null;

export function acquireLease(
	db: Database,
	nonce: string,
	inspect: (pid: number) => ProcessBirth | false | null = processBirth,
	now: number = Date.now(),
): boolean {
	const me = inspect(process.pid);
	if (!me) return false; // no birth identity = refuse unfenced authority
	return db.transaction(() => {
		const row = observeLease(db);
		if (row && row.nonce === nonce) {
			db.query("UPDATE distill_lease SET renewed_at = ? WHERE id = 1").run(now);
			return true;
		}
		if (row && controllerHolderLiveness(row, inspect) !== "dead") return false;
		db.query(
			"INSERT INTO distill_lease (id, nonce, host, pid, birth, started_at, renewed_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET nonce = excluded.nonce, host = excluded.host, pid = excluded.pid, birth = excluded.birth, started_at = excluded.started_at, renewed_at = excluded.renewed_at",
		).run(nonce, hostname(), process.pid, me.birth, now, now);
		return true;
	})();
}

export function releaseLease(db: Database, nonce: string): boolean {
	return (
		db.query("DELETE FROM distill_lease WHERE id = 1 AND nonce = ?").run(nonce)
			.changes === 1
	);
}
