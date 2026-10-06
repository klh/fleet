import type { GovernorStore } from "../lib/govdb.ts";
import { observation, type Observation } from "../lib/observation.ts";

export interface RecoveryIncident {
	project: string;
	sid: string;
	resource: string;
	attempts: number;
	last_at: number;
	resolved_at: number | null;
	consult_id: number | null;
}
export interface RecoveryConsult {
	id: number;
	project: string;
	asker_sid: string;
	expert_sid: string | null;
	scope: string | null;
	state: string;
	created_at: number;
	outcome: string | null;
}
export interface RecoverySnapshot {
	ts: number;
	observation: Observation;
	incidentsAvailable: boolean;
	feedbackAvailable: boolean;
	incidents: RecoveryIncident[];
	consults: RecoveryConsult[];
	outcomes: Record<string, number>;
}

/** Bounded, read-only projection; older installations remain distinguishable. */
export function recoverySnapshot(
	db: GovernorStore,
	project: string | null,
	now = Date.now(),
): RecoverySnapshot {
	const tables = new Set(
		(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((r) => r.name),
	);
	const filtered = !!project && project !== "all";
	const incidentsAvailable = tables.has("failure_incidents");
	const feedbackAvailable = tables.has("consult_feedback");
	const incidents = incidentsAvailable
		? (db
				.query(
					`SELECT project, sid, resource, attempts, last_at, resolved_at, consult_id FROM failure_incidents WHERE last_at >= ? ${filtered ? "AND project = ?" : ""} ORDER BY (resolved_at IS NULL) DESC, last_at DESC LIMIT 30`,
				)
				.all(
					...(filtered ? [now - 86_400_000, project] : [now - 86_400_000]),
				) as RecoveryIncident[])
		: [];
	const consults = tables.has("consults")
		? (db
				.query(
					`SELECT c.id, c.project, c.asker_sid, c.expert_sid, c.scope, c.state, c.created_at, ${feedbackAvailable ? "f.outcome" : "NULL AS outcome"} FROM consults c ${feedbackAvailable ? "LEFT JOIN consult_feedback f ON f.consult_id = c.id" : ""} WHERE c.created_at >= ? ${filtered ? "AND c.project = ?" : ""} ORDER BY c.created_at DESC LIMIT 30`,
				)
				.all(
					...(filtered ? [now - 86_400_000, project] : [now - 86_400_000]),
				) as RecoveryConsult[])
		: [];
	const outcomes: Record<string, number> = {};
	if (feedbackAvailable && tables.has("consults")) {
		const counts = db
			.query(
				`SELECT f.outcome, COUNT(*) AS n FROM consult_feedback f JOIN consults c ON c.id = f.consult_id WHERE f.recorded_at >= ? ${filtered ? "AND c.project = ?" : ""} GROUP BY f.outcome`,
			)
			.all(
				...(filtered ? [now - 86_400_000, project] : [now - 86_400_000]),
			) as { outcome: string; n: number }[];
		for (const r of counts) outcomes[r.outcome] = r.n;
	}
	return {
		ts: now,
		observation: observation(
			"governor-ledger",
			"incidents-and-consult-outcomes",
			filtered ? project : "all-projects",
			now,
			30_000,
			"ledger",
		),
		incidentsAvailable,
		feedbackAvailable,
		incidents,
		consults,
		outcomes,
	};
}
