// Repeated governor denials become one incident and at most one owner consult.
// This never grants a lease or weakens a gate. Telemetry failure is fail-open.
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ensureConsultOutbox, enqueueConsult } from "./consult-outbox.ts";

export interface FailureContext {
	project: string;
	sid: string;
	operation: string;
	errorClass: string;
	resource: string;
	generation: string;
	holder?: string;
	recovery: string;
}

function schema(db: Database): void {
	ensureConsultOutbox(db);
	db.run(`CREATE TABLE IF NOT EXISTS failure_incidents (
		project TEXT NOT NULL, fingerprint TEXT NOT NULL, sid TEXT NOT NULL,
		resource TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
		attempts INTEGER NOT NULL, consult_id INTEGER, resolved_at INTEGER,
		PRIMARY KEY(project, fingerprint, sid))`);
	db.run(
		"CREATE INDEX IF NOT EXISTS failure_incidents_age ON failure_incidents(last_at)",
	);
}

export function failureFingerprint(c: FailureContext): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				c.project,
				c.operation,
				c.errorClass,
				c.resource,
				c.generation,
			]),
		)
		.digest("hex")
		.slice(0, 24);
}

export function recordFailure(
	db: Database,
	c: FailureContext,
	now = Date.now(),
): string {
	const fingerprint = failureFingerprint(c);
	try {
		schema(db);
		return db.transaction(() => {
			db.query("DELETE FROM failure_incidents WHERE last_at < ?").run(
				now - 7 * 86_400_000,
			);
			const old = db
				.query(
					"SELECT attempts, consult_id, resolved_at, last_at, first_at FROM failure_incidents WHERE project = ? AND fingerprint = ? AND sid = ?",
				)
				.get(c.project, fingerprint, c.sid) as {
				attempts: number;
				consult_id: number | null;
				resolved_at: number | null;
				last_at: number;
				first_at: number;
			} | null;
			const fresh =
				!old || old.resolved_at !== null || now - old.last_at > 30 * 60_000;
			const attempts = fresh ? 1 : old.attempts + 1;
			let consultId = fresh ? null : old.consult_id;
			const queued = db
				.query(
					"SELECT COUNT(*) AS n FROM consults WHERE project = ? AND asker_sid = ? AND state = 'OPEN' AND created_at > ?",
				)
				.get(c.project, c.sid, now - 3_600_000) as { n: number };
			const expertQueue = db
				.query(
					"SELECT COUNT(*) AS n FROM consults WHERE project = ? AND expert_sid = ? AND state = 'OPEN' AND created_at > ?",
				)
				.get(c.project, c.holder ?? "", now - 3_600_000) as { n: number };
			if (
				attempts === 2 &&
				queued.n < 3 &&
				expertQueue.n < 3 &&
				c.holder &&
				c.holder !== c.sid &&
				db
					.query(
						"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'",
					)
					.get(c.holder, c.project)
			) {
				const question = `Repeated ${c.errorClass} on ${c.resource}; operation ${c.operation}; state ${c.generation}. Two unchanged attempts were denied. Can you confirm the current ownership and coordinate the next safe action? Required recovery: ${c.recovery}. Answer with evidence; this request does not transfer ownership.`;
				const result = db
					.query(
						"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)",
					)
					.run(c.project, c.sid, c.holder, question, c.resource, now);
				consultId = Number(result.lastInsertRowid);
				enqueueConsult(db, consultId, now);
				db.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', ?, ?, ?)",
				).run(
					now,
					c.sid,
					c.resource,
					JSON.stringify({
						project: c.project,
						consult: `C${consultId}`,
						q: question,
						fingerprint,
					}),
					c.holder,
				);
			}
			db.query(`INSERT INTO failure_incidents (project, fingerprint, sid, resource, first_at, last_at, attempts, consult_id, resolved_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(project, fingerprint, sid) DO UPDATE SET first_at = excluded.first_at, last_at = excluded.last_at, attempts = excluded.attempts, consult_id = excluded.consult_id, resolved_at = NULL`).run(
				c.project,
				fingerprint,
				c.sid,
				c.resource,
				fresh ? now : old.first_at,
				now,
				attempts,
				consultId,
			);
			if (attempts <= 2)
				db.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					now,
					c.sid,
					attempts === 1 ? "failure.observed" : "failure.repeated",
					c.resource,
					JSON.stringify({
						project: c.project,
						fingerprint,
						operation: c.operation,
						errorClass: c.errorClass,
						generation: c.generation,
						attempts,
						consult: consultId,
						recovery: c.recovery,
					}),
					c.sid,
				);
			const delivery = consultId
				? (db
						.query(
							"SELECT delivery_id,status,remote_consult_id FROM consult_outbox WHERE local_consult_id=?",
						)
						.get(consultId) as {
						delivery_id: string;
						status: string;
						remote_consult_id: number | null;
					} | null)
				: null;
			return `\nRECOVERY ${JSON.stringify({ fingerprint, attempts, next: c.recovery, consult: consultId ? `C${consultId}` : null, delivery: delivery ? { id: delivery.delivery_id, status: delivery.status, remoteConsult: delivery.remote_consult_id ? `C${delivery.remote_consult_id}` : null, note: "consult is the local incident ID; use remoteConsult for coord reply/feedback on a remote store" } : null, retry: attempts >= 2 ? "new evidence or consultation required; do not repeat unchanged" : "only after the recovery condition changes" })}`;
		})();
	} catch {
		return `\nRECOVERY ${JSON.stringify({ fingerprint, next: c.recovery, retry: "only after the recovery condition changes" })}`;
	}
}

export function resolveFailures(
	db: Database,
	project: string,
	sid: string,
	resource: string,
	now = Date.now(),
): void {
	try {
		schema(db);
		const changed = db
			.query(
				"UPDATE failure_incidents SET resolved_at = ? WHERE project = ? AND sid = ? AND resource = ? AND resolved_at IS NULL",
			)
			.run(now, project, sid, resource);
		if (changed.changes)
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'failure.resolved', ?, ?, ?)",
			).run(
				now,
				sid,
				resource,
				JSON.stringify({
					project,
					resolved: changed.changes,
					condition: "governed acquisition succeeded",
				}),
				sid,
			);
	} catch {
		/* telemetry must not affect acquisition */
	}
}
