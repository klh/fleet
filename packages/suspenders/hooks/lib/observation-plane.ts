// hooks/lib/observation-plane.ts — W621.1: the observation plane's core
// contract (docs/upstream-observability-architecture.md §2, §3, §5). An
// unsampled, idempotent stream of minimal lane observations with an explicit
// visibility split: an install OWNS its executors' lanes (full detail, only
// it asserts lifecycle), is AUTHORIZED to see per project scope (authority
// sees all its lanes), and MERELY OBSERVES pass-through traffic (counts,
// latency, errors only — per-lane status stays UNKNOWN, never "dead"; a
// disconnected observer degrades to UNKNOWN per Sparkplug session-generation
// semantics, arch doc §"Sparkplug"). One writer, durable outbox, idempotent
// ingest — a shared broker waits for measured replay/fan-out need (§5).
// Accounting/billing stays on its own path; this plane is visibility only.

import type { Database } from "bun:sqlite";

export const OBSERVATION_SCHEMA_VERSION = 1;

/** bounded outbox: local persistence must stay inside its failure domain */
export const OBSERVATION_OUTBOX_CAPACITY = 5000;

/** observed presence older than this is stale evidence, not proof of death */
export const OBSERVATION_FRESHNESS_MS = 5 * 60_000;

export type ObservationType =
	| "lane.admitted"
	| "request.started"
	| "request.ended"
	| "lane.presence"
	| "observer.disconnected";

/**
 * OBSERVES is a viewer class, not a lane property: the same observation
 * streams at different detail depending on who reads it.
 */
export type VisibilityClass = "owns" | "authorized" | "observes";

export interface ObservationEvent {
	/** unique per source — CloudEvents 1.0.2: equal (source, id) = duplicate */
	id: string;
	/** observing store identity (the consult-outbox store-id shape) */
	source: string;
	/** observer incarnation: a restart mints a new boot, never a new lane */
	bootId: string;
	/** monotonic per (source, bootId); gaps are detected, never guessed */
	seq: number;
	type: ObservationType;
	/** logical project key (ResolvedProject.id — the stage-1 contract) */
	projectId: string;
	laneId: string;
	dispatchId?: string;
	requestId?: string;
	sourceTime: number;
	outcome?: "ok" | "error";
	/** pass-through traffic facts; never lane content or credentials */
	latencyMs?: number;
}

export interface ObservationGap {
	from: number;
	to: number;
}

export interface IngestResult {
	accepted: number;
	duplicates: number;
	rejectedStaleGeneration: number;
	/** payloads failing the schema check — never silently counted as dupes */
	invalid: number;
	gaps: ObservationGap[];
}

export interface ViewerScope {
	visibility: VisibilityClass;
	/** AUTHORIZED viewers see lanes only inside this project-key scope */
	projectIds?: string[];
}

export interface LaneProjection {
	projectId: string;
	laneId: string;
	/**
	 * Only OWNS/AUTHORIZED (authority) views ever see "active"; everything
	 * else — and any stale/disconnected evidence — is "unknown". "dead" is
	 * not a status this plane may assert: termination belongs to the work
	 * plane's authority alone.
	 */
	status: "active" | "unknown";
	lastSeenSourceTime: number | null;
	/** full detail rides only with OWNS/AUTHORIZED; OBSERVES gets null */
	detail: {
		dispatchId: string | null;
		requestId: string | null;
		lastOutcome: "ok" | "error" | null;
	} | null;
}

export interface LaneSummary {
	visibility: VisibilityClass;
	lanes: LaneProjection[];
	/** OBSERVES traffic: counts and latency only — no per-lane attribution */
	counts: { lanes: number; requests: number; errors: number };
	latencyMs: { avg: number | null; max: number | null };
}

function ensureObservationPlane(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS observation_outbox (
		id TEXT NOT NULL, source TEXT NOT NULL, boot_id TEXT NOT NULL,
		seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
		created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
		PRIMARY KEY (source, id))`);
	db.run(`CREATE TABLE IF NOT EXISTS observation_events (
		source TEXT NOT NULL, id TEXT NOT NULL, boot_id TEXT NOT NULL,
		seq INTEGER NOT NULL, type TEXT NOT NULL, project_id TEXT NOT NULL,
		lane_id TEXT NOT NULL, dispatch_id TEXT, request_id TEXT,
		source_time INTEGER NOT NULL, ingest_time INTEGER NOT NULL,
		outcome TEXT, latency_ms INTEGER,
		PRIMARY KEY (source, id))`);
	db.run(
		"CREATE INDEX IF NOT EXISTS observation_events_lane ON observation_events(project_id, lane_id, source_time)",
	);
	// one generation row per observer incarnation; disconnected_at is the
	// Sparkplug-style death of a CONNECTION, never of a lane
	db.run(`CREATE TABLE IF NOT EXISTS observation_generations (
		source TEXT NOT NULL, boot_id TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
		connected_at INTEGER NOT NULL, disconnected_at INTEGER,
		PRIMARY KEY (source, boot_id))`);
	db.run(`CREATE TABLE IF NOT EXISTS observation_outbox_meta (
		key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** stable per-store observer identity — the same shape consultStoreId mints */
export function observationStoreId(db: Database): string {
	ensureObservationPlane(db);
	db.query(
		"INSERT OR IGNORE INTO observation_outbox_meta(key,value) VALUES('store-id',?)",
	).run(crypto.randomUUID());
	return (
		db
			.query("SELECT value FROM observation_outbox_meta WHERE key='store-id'")
			.get() as { value: string }
	).value;
}

/**
 * Marks an observer incarnation's connection dead. Subsequent events from
 * the same boot are rejected as stale generation: a delayed old death must
 * not override a newly connected session, and the death carries no lane
 * status — downstream lanes simply become unobserved (UNKNOWN).
 */
export function markObserverDisconnected(
	db: Database,
	source: string,
	bootId: string,
	now: number,
): boolean {
	ensureObservationPlane(db);
	const r = db.run(
		"UPDATE observation_generations SET disconnected_at = ? WHERE source = ? AND boot_id = ? AND disconnected_at IS NULL",
		[now, source, bootId],
	).changes;
	return r > 0;
}

/**
 * Local durable outbox append — the transaction boundary that pairs a lane
 * observation with its delivery intent. Throws on capacity: an explicit
 * overflow policy, never silent loss (arch doc §5).
 */
export function appendObservation(
	db: Database,
	event: ObservationEvent,
	now: number,
): void {
	ensureObservationPlane(db);
	const pending = db
		.query(
			"SELECT count(*) AS n FROM observation_outbox WHERE status = 'PENDING'",
		)
		.get() as { n: number };
	if (pending.n >= OBSERVATION_OUTBOX_CAPACITY)
		throw new Error("Observation outbox capacity reached");
	db.query(
		"INSERT INTO observation_outbox(source,id,boot_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?,?)",
	).run(
		event.source,
		event.id,
		event.bootId,
		event.seq,
		event.type,
		JSON.stringify(event),
		now,
	);
}

function validEvent(raw: unknown): raw is ObservationEvent {
	if (typeof raw !== "object" || raw === null) return false;
	const e = raw as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		typeof e.source === "string" &&
		typeof e.bootId === "string" &&
		typeof e.seq === "number" &&
		typeof e.type === "string" &&
		typeof e.projectId === "string" &&
		typeof e.laneId === "string" &&
		typeof e.sourceTime === "number"
	);
}

/**
 * Idempotent batch ingest into the read model: dedup on (source, id)
 * transactionally BEFORE any projection update; reject events from a
 * disconnected observer boot (stale generation); detect sequence gaps per
 * (source, bootId) and report them — a gap is lost evidence, not zero.
 */
export function ingestObservations(
	db: Database,
	events: unknown[],
	now: number,
): IngestResult {
	ensureObservationPlane(db);
	const result: IngestResult = {
		accepted: 0,
		duplicates: 0,
		rejectedStaleGeneration: 0,
		invalid: 0,
		gaps: [],
	};
	const insert = db.query(
		"INSERT OR IGNORE INTO observation_events(source,id,boot_id,seq,type,project_id,lane_id,dispatch_id,request_id,source_time,ingest_time,outcome,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	const gen = db.query(
		"SELECT last_seq FROM observation_generations WHERE source = ? AND boot_id = ?",
	);
	const genUp = db.query(
		`INSERT INTO observation_generations(source,boot_id,last_seq,connected_at) VALUES(?,?,?,?)
		 ON CONFLICT(source,boot_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)`,
	);
	const stale = db.query(
		"SELECT disconnected_at FROM observation_generations WHERE source = ? AND boot_id = ?",
	);
	db.transaction(() => {
		for (const raw of events) {
			if (!validEvent(raw)) {
				result.invalid += 1;
				continue;
			}
			const e: ObservationEvent = raw;
			const g = stale.get(e.source, e.bootId) as
				| { disconnected_at: number | null }
				| undefined;
			if (g?.disconnected_at != null) {
				result.rejectedStaleGeneration += 1;
				continue;
			}
			const prev = gen.get(e.source, e.bootId) as
				| { last_seq: number }
				| undefined;
			const lastSeq = prev?.last_seq ?? 0;
			if (e.seq > lastSeq + 1)
				result.gaps.push({ from: lastSeq + 1, to: e.seq - 1 });
			const changed = insert.run(
				e.source,
				e.id,
				e.bootId,
				e.seq,
				e.type,
				e.projectId,
				e.laneId,
				e.dispatchId ?? null,
				e.requestId ?? null,
				e.sourceTime,
				now,
				e.outcome ?? null,
				e.latencyMs ?? null,
			).changes;
			if (changed > 0) result.accepted += 1;
			else result.duplicates += 1;
			genUp.run(e.source, e.bootId, e.seq, now);
		}
	})();
	return result;
}

/**
 * The scoped read model (arch doc §3). OWNS/AUTHORIZED viewers get per-lane
 * detail with authority-derived presence; OBSERVES viewers get distinct-lane
 * counts, request/error totals and latency — and every lane status UNKNOWN.
 * Presence is freshness-windowed: stale evidence is unknown, never death.
 */
export function projectLanes(
	db: Database,
	viewer: ViewerScope,
	now: number,
): LaneSummary {
	ensureObservationPlane(db);
	const scoped = viewer.projectIds ?? null;
	// bun:sqlite rejects a leading null positional — scope rides a 0/1 flag
	const scopedFlag = scoped == null ? 0 : 1;
	const scopedJson = JSON.stringify(scoped ?? []);
	const rows = db
		.query(
			`SELECT project_id, lane_id,
				max(source_time) AS last_seen,
				sum(CASE WHEN type = 'request.started' THEN 1 ELSE 0 END) AS requests,
				sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors
			FROM observation_events
			WHERE (? = 0 OR project_id IN (SELECT value FROM json_each(?)))
			GROUP BY project_id, lane_id`,
		)
		.all(scopedFlag, scopedJson) as {
		project_id: string;
		lane_id: string;
		last_seen: number;
		requests: number;
		errors: number;
	}[];

	const latency = db
		.query(
			`SELECT avg(latency_ms) AS avg, max(latency_ms) AS max
			FROM observation_events WHERE type = 'request.ended' AND latency_ms IS NOT NULL
			AND (? = 0 OR project_id IN (SELECT value FROM json_each(?)))`,
		)
		.get(scopedFlag, scopedJson) as {
		avg: number | null;
		max: number | null;
	};

	// the authority check: does THIS viewer's own install hold a fresh
	// lane.presence/lane.admitted for the lane? (owns = same store source)
	const authority = db.query(
		`SELECT source_time FROM observation_events
		WHERE project_id = ? AND lane_id = ? AND type IN ('lane.presence','lane.admitted')
		AND source = (SELECT value FROM observation_outbox_meta WHERE key = 'store-id')
		ORDER BY source_time DESC LIMIT 1`,
	);

	const lanes: LaneProjection[] = rows.map((r) => {
		const authorityRow =
			viewer.visibility === "observes"
				? null
				: (authority.get(r.project_id, r.lane_id) as {
						source_time: number;
					} | null);
		const fresh =
			authorityRow != null &&
			now - authorityRow.source_time <= OBSERVATION_FRESHNESS_MS;
		return {
			projectId: r.project_id,
			laneId: r.lane_id,
			status: fresh ? "active" : "unknown",
			lastSeenSourceTime: r.last_seen,
			detail:
				viewer.visibility === "observes"
					? null
					: latestDetail(db, r.project_id, r.lane_id),
		};
	});

	return {
		visibility: viewer.visibility,
		lanes,
		counts: {
			lanes: rows.length,
			requests: rows.reduce((n, r) => n + Number(r.requests), 0),
			errors: rows.reduce((n, r) => n + Number(r.errors), 0),
		},
		latencyMs: { avg: latency.avg ?? null, max: latency.max ?? null },
	};
}

function latestDetail(
	db: Database,
	projectId: string,
	laneId: string,
): LaneProjection["detail"] {
	const row = db
		.query(
			`SELECT dispatch_id, request_id, outcome FROM observation_events
			WHERE project_id = ? AND lane_id = ? AND type = 'request.ended'
			ORDER BY source_time DESC LIMIT 1`,
		)
		.get(projectId, laneId) as
		| {
				dispatch_id: string | null;
				request_id: string | null;
				outcome: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		dispatchId: row.dispatch_id,
		requestId: row.request_id,
		lastOutcome:
			row.outcome === "ok" || row.outcome === "error" ? row.outcome : null,
	};
}
