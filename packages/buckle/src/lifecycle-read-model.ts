// src/lifecycle-read-model.ts — W1312: the joined lane-lifecycle query
// surface + observer loss counters. The W461 projection records
// admit/start/end per request (unsampled, per-observer sequence); the
// W824 ledger records attempts/target/status per rid. Neither alone
// answers "what happened to this request" — this joins them (ATTACH the
// ledger readonly, LEFT JOIN on rid: projection-only = never reached the
// route decision; ledger-only = pre-W461 legacy) and derives per-observer
// gap/drop counters from the durable sequence (observer_state.last_seq vs
// distinct projected ids — rotation, overflow, or crash loss, never
// inferred away). The outbox's in-memory stats() is the live-process
// face; these counters are the queryable durable face.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** One request's joined lifecycle: projection edges + ledger outcome. */
export interface LifecycleRow {
	source: string;
	rid: string;
	lane: string;
	actor: string;
	model: string;
	dialect: string;
	admittedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	outcome: string | null;
	status: number | null;
	/** Attempts the projection saw (ended event). */
	edgeAttempts: number | null;
	/** Ledger side — null when no route_audit row carries this rid. */
	ledgerTs: string | null;
	ledgerOk: number | null;
	ledgerStatus: number | null;
	ledgerAttempts: number | null;
	targetKind: string | null;
	targetHost: string | null;
	targetPort: number | null;
	targetModel: string | null;
	/** Ledger queue wait (W770) — null when the ledger never queued. */
	queueWaitMs: number | null;
	errorCode: string | null;
	/** true = both sides present and attempts agree; false = one side
	 *  missing or a count drift — the cross-ledger honesty flag. */
	attemptsAgree: boolean;
}

/** Per-observer (per-boot source) durable loss counters. */
export interface ObserverLossRow {
	source: string;
	/** Highest sequence the observer emitted (observer_state.last_seq). */
	emitted: number;
	/** Distinct events that reached the projection (dedup by source+id). */
	observed: number;
	/** emitted − observed: rotated/overflowed/crash-lost events ≥ 0. */
	gaps: number;
}

export interface LifecycleQuery {
	source?: string | null;
	lane?: string | null;
	errorOnly?: boolean;
	/** unmatched=1 → rows with no ledger half; matched=1 → rows with one. */
	ledgerMatch?: "matched" | "unmatched" | null;
	limit?: number;
}

export interface LifecycleSnapshot {
	rows: LifecycleRow[];
	/** Per-observer loss rows — the board renders gaps per hub source. */
	loss: ObserverLossRow[];
	/** emitted/observed/gaps summed over the selected scope. */
	totals: { emitted: number; observed: number; gaps: number };
}

const LIFECYCLE_CAP = 200;

/** Joined lifecycle rows + loss counters over the projection db with the
 *  ledger attached. Absent dbs degrade to empty rows (an absent ledger
 *  still yields projection-only rows — the join is the optional half). */
export function lifecycleSnapshot(
	paths: { obsDb: string; ledger?: string | null },
	q: LifecycleQuery = {},
): LifecycleSnapshot {
	const loss = lifecycleLoss(paths.obsDb);
	const rows = paths.ledger
		? lifecycleRows(paths.obsDb, paths.ledger, q)
		: lifecycleRows(paths.obsDb, null, q);
	const totals = loss.reduce(
		(acc, l) => ({
			emitted: acc.emitted + l.emitted,
			observed: acc.observed + l.observed,
			gaps: acc.gaps + l.gaps,
		}),
		{ emitted: 0, observed: 0, gaps: 0 },
	);
	return { rows, loss, totals };
}

/** Durable gap/drop counters, per observer source. Empty/absent db = no
 *  rows — an unwired observer is not a lossy one. */
export function lifecycleLoss(obsDb: string): ObserverLossRow[] {
	if (!existsSync(obsDb)) return [];
	let db: Database | null = null;
	try {
		db = new Database(obsDb, { readonly: true });
		return db
			.query(
				`SELECT o.source AS source,
				COALESCE(s.last_seq, 0) AS emitted,
				COUNT(DISTINCT o.id) AS observed
				FROM obs_events o
				LEFT JOIN observer_state s ON s.source = o.source
				GROUP BY o.source ORDER BY MAX(o.rowid) DESC LIMIT 64`,
			)
			.all()
			.map(
				(r: {
					source: string;
					emitted: number;
					observed: number;
				}): ObserverLossRow => ({
					source: r.source,
					emitted: r.emitted,
					observed: r.observed,
					gaps: Math.max(0, r.emitted - r.observed),
				}),
			);
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

/** The joined rows. The ledger attaches read-only; any attach/read
 *  failure degrades to projection-only rows (the ledger is the optional
 *  half of the join, the projection is the spine). */
function lifecycleRows(
	obsDb: string,
	ledger: string | null,
	q: LifecycleQuery,
): LifecycleRow[] {
	if (!existsSync(obsDb)) return [];
	let db: Database | null = null;
	try {
		db = new Database(obsDb, { readonly: true });
		if (ledger && existsSync(ledger)) {
			const safe = ledger.replace(/'/g, "''");
			db.run(`ATTACH DATABASE '${safe}' AS led`);
		}
		return queryLifecycle(db, q);
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

function queryLifecycle(db: Database, q: LifecycleQuery): LifecycleRow[] {
	const limit = Math.min(Math.max(q.limit ?? 50, 1), LIFECYCLE_CAP);
	const ledgerPresent = !!(
		db
			.query("SELECT 1 FROM pragma_database_list WHERE name = 'led'")
			.get() as { name?: string } | undefined
	);
	const where: string[] = ["1=1"];
	const args: (string | number)[] = [];
	if (q.source) {
		where.push("e.source = ?");
		args.push(q.source);
	}
	if (q.lane) {
		where.push("e.lane = ?");
		args.push(q.lane);
	}
	if (q.errorOnly) where.push("e.outcome IN ('errored','denied')");
	if (q.ledgerMatch === "matched") where.push("a.rid IS NOT NULL");
	if (q.ledgerMatch === "unmatched") where.push("a.rid IS NULL");
	const ledgerCols = ledgerPresent
		? `a.ts AS ledgerTs, a.ok AS ledgerOk, a.status AS ledgerStatus,
		a.attempts AS ledgerAttempts, a.target_kind AS targetKind,
		a.target_host AS targetHost, a.target_port AS targetPort,
		a.target_model AS targetModel, a.error_code AS errorCode,
		(SELECT MAX(r.queue_wait_ms) FROM led.route_attempt r
			WHERE r.rid = e.rid) AS queueWaitMs,
		CASE WHEN a.rid IS NULL THEN 0
			WHEN a.attempts IS NULL OR e.attempts IS NULL THEN 0
			WHEN a.attempts = e.attempts THEN 1 ELSE 0 END AS attemptsAgreeNum`
		: `NULL AS ledgerTs, NULL AS ledgerOk, NULL AS ledgerStatus,
		NULL AS ledgerAttempts, NULL AS targetKind, NULL AS targetHost,
		NULL AS targetPort, NULL AS targetModel, NULL AS errorCode,
		NULL AS queueWaitMs, 0 AS attemptsAgreeNum`;
	const rows = db
		.query(
			`SELECT e.source AS source, e.rid AS rid, e.lane AS lane,
			e.actor AS actor, e.model AS model, e.dialect AS dialect,
			e.admitted_at AS admittedAt, e.started_at AS startedAt,
			e.ended_at AS endedAt, e.outcome AS outcome, e.status AS status,
			e.attempts AS edgeAttempts, ${ledgerCols}
			FROM request_edges e
			LEFT JOIN ${ledgerPresent ? "led.route_audit" : "(SELECT NULL AS rid)"} a
				ON a.rid = e.rid
			WHERE ${where.join(" AND ")}
			ORDER BY e.admitted_at DESC, e.rid DESC LIMIT ${limit}`,
		)
		.all(...args) as Array<
		LifecycleRow & { attemptsAgreeNum: number | null }
	>;
	return rows.map(({ attemptsAgreeNum, ...r }) => ({
		...r,
		attemptsAgree: attemptsAgreeNum === 1,
	}));
}
