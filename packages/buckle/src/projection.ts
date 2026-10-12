// src/projection.ts — W461 stage 3: the lane/route read model. Projected
// tables over the stage-2 observation stream (upstream-observability-
// architecture.md §3): request edges + per-observer state, idempotent
// ingest (CloudEvents source+id dedup, transactional batch), gap detection
// via the observer's per-boot sequence, and active-request reconciliation
// after crashes. Stale/expired observer evidence is UNKNOWN — never proof
// a lane ended. Scoped queries only: immediate-downstream grouping by
// default, source/origin/time/error filters, distinct-lane counts and
// cursor-paginated detail. No work-graph replication, ever.
import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import type { Observation } from "./observe.ts";

/** An active edge older than this is closed as unknown at ingest — the
 *  observer may have died mid-request; its silence is not an outcome. */
const ACTIVE_TTL_MS = 30 * 60_000;

export interface RequestEdge {
	source: string;
	rid: string;
	lane: string;
	actor: string;
	model: string;
	dialect: string;
	traceparent: string;
	admittedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	outcome: string | null;
	status: number | null;
	attempts: number | null;
	/** W706: verified origin hub vs the immediate peer that forwarded this
	 *  leg (peer = null/'' → the request entered the fleet at this hub). */
	origin: string;
	peer: string | null;
}

export interface RouteGroup {
	/** The observer (immediate downstream of the viewer): group key. */
	source: string;
	lanes: number;
	requests: number;
	errors: number;
	active: number;
	lastAt: number;
}

export interface RouteSnapshot {
	ts: number;
	groups: RouteGroup[];
	/** Distinct lanes across the selected scope — groups may overlap, so
	 *  group counts are not additive (doc §3). */
	lanes: number;
	requests: number;
	errors: number;
	edges: RequestEdge[];
	/** true when the requested cursor predates retention — the client must
	 *  resync from the head snapshot (doc §3). */
	resync: boolean;
	nextCursor: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS obs_events (
	source TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
	time TEXT NOT NULL, data TEXT NOT NULL,
	PRIMARY KEY (source, id));
CREATE TABLE IF NOT EXISTS request_edges (
	source TEXT NOT NULL, rid TEXT NOT NULL, lane TEXT NOT NULL,
	actor TEXT NOT NULL, model TEXT NOT NULL, dialect TEXT NOT NULL,
	traceparent TEXT NOT NULL,
	admitted_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
	outcome TEXT, status INTEGER, attempts INTEGER,
	origin TEXT NOT NULL DEFAULT '', peer TEXT,
	PRIMARY KEY (source, rid));
CREATE INDEX IF NOT EXISTS request_edges_admitted ON request_edges (admitted_at DESC);
CREATE TABLE IF NOT EXISTS observer_state (
	source TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);
`;

export class LaneProjection {
	private readonly db: Database;
	private insEvent: Statement;
	private insEdge: Statement;
	private edgeStarted: Statement;
	private edgeEnded: Statement;
	private upsertSeq: Statement;
	private lastSeq: Statement;
	private closeStale: Statement;
	private closeSourceStale: Statement;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		// W706: hop columns heal onto pre-W706 projection dbs the same way the
		// ledger heals cache_r/cache_c — idempotent per open, NULL peer = the
		// request entered the fleet at this hub.
		const edgeCols = (
			this.db
				.query("SELECT name FROM pragma_table_info('request_edges')")
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		if (!edgeCols.includes("origin"))
			this.db.run("ALTER TABLE request_edges ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
		if (!edgeCols.includes("peer"))
			this.db.run("ALTER TABLE request_edges ADD COLUMN peer TEXT");
		this.insEvent = this.db.query(
			"INSERT OR IGNORE INTO obs_events (source, id, type, time, data) VALUES (?, ?, ?, ?, ?)",
		);
		this.insEdge = this.db.query(
			`INSERT OR IGNORE INTO request_edges
			(source, rid, lane, actor, model, dialect, traceparent, admitted_at, origin, peer)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.edgeStarted = this.db.query(
			`UPDATE request_edges SET started_at = ? WHERE source = ? AND rid = ? AND started_at IS NULL`,
		);
		this.edgeEnded = this.db.query(
			`UPDATE request_edges SET ended_at = ?, outcome = ?, status = ?, attempts = ?
			WHERE source = ? AND rid = ? AND ended_at IS NULL`,
		);
		this.upsertSeq = this.db.query(
			`INSERT INTO observer_state (source, last_seq) VALUES (?, ?)
			ON CONFLICT(source) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
		);
		this.closeStale = this.db.query(
			`UPDATE request_edges SET ended_at = ?, outcome = 'unknown'
			WHERE ended_at IS NULL AND admitted_at < ?`,
		);
		this.closeSourceStale = this.db.query(
			`UPDATE request_edges SET ended_at = ?, outcome = 'unknown'
			WHERE ended_at IS NULL AND source = ? AND admitted_at <= ?`,
		);
		this.lastSeq = this.db.query(
			"SELECT last_seq FROM observer_state WHERE source = ?",
		);
	}

	private lastSeqOf(source: string): number | null {
		const row = this.lastSeq.get(source) as { last_seq: number } | null;
		return row?.last_seq ?? null;
	}

	close(): void {
		this.db.close();
	}

	/** Idempotent batch ingest: one transaction, source+id dedup at the
	 *  door, then edge transitions. A per-source sequence gap means the
	 *  outbox rotated or the observer crashed — that observer's still-active
	 *  edges close as unknown (reconciled, never stuck). */
	ingest(observations: Observation[], now = Date.now()): number {
		let applied = 0;
		this.db.transaction(() => {
			this.closeStale.run(now, now - ACTIVE_TTL_MS);
			// pass 1: gap detection against the PRE-BATCH sequence state — a
			// jump past last+1 means events were lost (rotation, crash) and
			// that observer's stuck active edges reconcile to unknown before
			// this batch projects anything new
			const gapSources = new Set<string>();
			for (const o of observations) {
				if (
					!o ||
					typeof o.source !== "string" ||
					typeof o.id !== "string" ||
					!/^\d+$/.test(o.id)
				)
					continue;
				const last = this.lastSeqOf(o.source);
				if (last !== null && Number(o.id) > last + 1) gapSources.add(o.source);
			}
			for (const source of gapSources)
				this.closeSourceStale.run(now, source, now);
			for (const o of observations) {
				if (
					!o ||
					typeof o.source !== "string" ||
					typeof o.id !== "string" ||
					!/^\d+$/.test(o.id)
				)
					continue;
				const r = this.insEvent.run(
					o.source,
					o.id,
					o.type,
					o.time,
					JSON.stringify(o.data ?? {}),
				);
				if (r.changes === 0) continue; // duplicate — already projected
				applied++;
				const d = (o.data ?? {}) as Record<string, unknown>;
				const rid = typeof d.rid === "string" ? d.rid : "";
				if (o.type === "lane.request.admitted" && rid) {
					this.insEdge.run(
						o.source,
						rid,
						typeof d.lane === "string" ? d.lane : "",
						typeof d.actor === "string" ? d.actor : "",
						typeof d.model === "string" ? d.model : "",
						typeof d.dialect === "string" ? d.dialect : "",
						typeof d.traceparent === "string" ? d.traceparent : "",
						Date.parse(o.time) || now,
						typeof d.origin === "string" ? d.origin : "",
						typeof d.peer === "string" ? d.peer : null,
					);
				} else if (o.type === "lane.request.started" && rid) {
					this.edgeStarted.run(now, o.source, rid);
				} else if (o.type === "lane.request.ended" && rid) {
					this.edgeEnded.run(
						now,
						typeof d.outcome === "string" ? d.outcome : "unknown",
						typeof d.status === "number" ? d.status : null,
						typeof d.attempts === "number" ? d.attempts : null,
						o.source,
						rid,
					);
				}
				this.upsertSeq.run(o.source, Number(o.id));
			}
		})();
		return applied;
	}

	/** Scoped snapshot: immediate-downstream grouping (per observer source)
	 *  by default, source/origin/time/error filters, distinct-lane counts, and
	 *  cursor-paginated edge detail (keyset on admitted_at + rid). */
	snapshot(
		q: {
			source?: string | null;
			originFilter?: string | null;
			since?: number | null;
			until?: number | null;
			errorOnly?: boolean;
			limit?: number;
			cursor?: string | null;
		} = {},
	): RouteSnapshot {
		const now = Date.now();
		const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
		const where: string[] = ["1=1"];
		const args: (string | number)[] = [];
		if (q.source) {
			where.push("source = ?");
			args.push(q.source);
		}
		if (q.originFilter) {
			where.push("origin = ?");
			args.push(q.originFilter);
		}
		if (q.since !== undefined && q.since !== null) {
			where.push("admitted_at >= ?");
			args.push(q.since);
		}
		if (q.until !== undefined && q.until !== null) {
			where.push("admitted_at < ?");
			args.push(q.until);
		}
		if (q.errorOnly) where.push("outcome IN ('errored','denied')");
		const clause = where.join(" AND ");
		const groups = this.db
			.query(
				`SELECT source,
				COUNT(DISTINCT lane) AS lanes, COUNT(*) AS requests,
				SUM(CASE WHEN outcome IN ('errored','denied') THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS active,
				MAX(admitted_at) AS lastAt
				FROM request_edges WHERE ${clause}
				GROUP BY source ORDER BY lastAt DESC LIMIT 64`,
			)
			.all(...args) as RouteGroup[];
		const totals = this.db
			.query(
				`SELECT COUNT(DISTINCT lane) AS lanes, COUNT(*) AS requests,
				SUM(CASE WHEN outcome IN ('errored','denied') THEN 1 ELSE 0 END) AS errors
				FROM request_edges WHERE ${clause}`,
			)
			.get(...args) as { lanes: number; requests: number; errors: number };
		// keyset pagination: cursor = "<admitted_at>:<rid>"; a cursor older
		// than retention (nothing at or before it) asks the client to resync
		let resync = false;
		let cursorClause = "";
		const cursorArgs: (string | number)[] = [];
		if (q.cursor) {
			const [at, rid] = q.cursor.split(":");
			if (at && rid && /^\d+$/.test(at)) {
				cursorClause = "AND (admitted_at < ? OR (admitted_at = ? AND rid < ?))";
				cursorArgs.push(Number(at), Number(at), rid);
				const older = this.db
					.query(
						`SELECT 1 FROM request_edges WHERE ${clause}
						AND admitted_at <= ? LIMIT 1`,
					)
					.get(...args, Number(at));
				if (!older) resync = true;
			} else {
				resync = true; // unparseable cursor: resync from the head
			}
		}
		const edges = this.db
			.query(
				`SELECT source, rid, lane, actor, model, dialect, traceparent,
				admitted_at AS admittedAt, started_at AS startedAt, ended_at AS endedAt,
				outcome, status, attempts, origin, peer
				FROM request_edges WHERE ${clause} ${cursorClause}
				ORDER BY admitted_at DESC, rid DESC LIMIT ${limit}`,
			)
			.all(...args, ...cursorArgs) as RequestEdge[];
		const last = edges[edges.length - 1];
		const more = last
			? this.db
					.query(
						`SELECT 1 FROM request_edges WHERE ${clause}
						AND (admitted_at < ? OR (admitted_at = ? AND rid < ?)) LIMIT 1`,
					)
					.get(...args, last.admittedAt, last.admittedAt, last.rid)
			: false;
		return {
			ts: now,
			groups,
			lanes: totals?.lanes ?? 0,
			requests: totals?.requests ?? 0,
			errors: totals?.errors ?? 0,
			edges,
			resync,
			nextCursor: more && last ? `${last.admittedAt}:${last.rid}` : null,
		};
	}
}

/** Tails the stage-2 outbox into the projection: byte-offset tracked, only
 *  complete lines consumed (a torn crash tail waits — offset-only: the
 *  partial stays in the file and combines with the append, never a carry),
 *  rotation (file smaller than the offset) restarts from the head. */
export class OutboxTailer {
	private offset = 0;

	constructor(
		private readonly projection: LaneProjection,
		private readonly path: string,
	) {}

	async poll(now = Date.now()): Promise<number> {
		const size = (await stat(this.path).catch(() => null))?.size ?? 0;
		if (size < this.offset) this.offset = 0; // rotated: head is new content
		if (size === this.offset) return 0;
		const chunk = await Bun.file(this.path)
			.slice(this.offset)
			.text()
			.catch(() => "");
		if (!chunk) return 0;
		// offset-only: the torn tail stays in the file and combines with the
		// append on the next poll — carrying it here would glue the partial
		// to its own re-read and corrupt the completed line (W717)
		const complete = chunk.endsWith("\n")
			? chunk
			: chunk.slice(0, chunk.lastIndexOf("\n") + 1);
		this.offset += complete.length;
		if (!complete) return 0;
		const obs = complete
			.split("\n")
			.filter((l) => l.length > 0)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as Observation];
				} catch {
					return [];
				}
			});
		return obs.length > 0 ? this.projection.ingest(obs, now) : 0;
	}
}
