// hooks/lib/observation-producer.ts — W705: the W621 observation plane's
// missing producer. Tails buckle's stage-2 NDJSON outbox file (the
// BUCKLE_OBSERVATIONS_PATH stream), maps each CloudEvent to the plane's
// ObservationEvent contract, appends through appendObservation (the durable
// outbox, arch doc §5) and drains PENDING rows through ingestObservations
// into the read model. Idempotent end to end: the tail is byte-offset
// tracked, the drain's dedup keys on (source, id), so a crash between
// append and delete replays as duplicates, never double-counts. Enabled by
// config: KLH_OBSERVATION_OUTBOX names the outbox file; unset = inert
// (config-over-code).
import { stat } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import {
	appendObservation,
	ensureObservationPlane,
	ingestObservations,
	type ObservationEvent,
	type ObservationType,
} from "./observation-plane.ts";
/** buckle CloudEvent type -> plane type. Unknown types never map — the
 *  plane's vocabulary is closed (ObservationType). */
const TYPE_MAP: Record<string, ObservationType> = {
	"lane.request.admitted": "lane.admitted",
	"lane.request.started": "request.started",
	"lane.request.ended": "request.ended",
};

/**
 * One buckle CloudEvents line -> one plane event, or null when the line is
 * not a mappable observation: torn line, foreign spec, unknown type,
 * unparsable time, non-decimal seq.
 */
export function mapCloudEvent(raw: unknown): ObservationEvent | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (o.specversion !== "1.0") return null;
	const type = TYPE_MAP[o.type as string];
	if (!type) return null;
	if (typeof o.source !== "string" || o.source.length === 0) return null;
	if (typeof o.id !== "string" || !/^\d+$/.test(o.id)) return null;
	const sourceTime = Date.parse(o.time as string);
	if (!Number.isFinite(sourceTime)) return null;
	const data = (o.data ?? {}) as Record<string, unknown>;
	const actor = typeof data.actor === "string" ? data.actor : "";
	const lane = typeof data.lane === "string" ? data.lane : "";
	const rid = typeof data.rid === "string" ? data.rid : "";
	const event: ObservationEvent = {
		id: o.id,
		source: o.source,
		bootId: o.source.slice(o.source.lastIndexOf("/") + 1),
		seq: Number(o.id),
		type,
		projectId: actor || "unknown",
		laneId: lane || rid || "unknown",
		sourceTime,
	};
	if (rid) event.requestId = rid;
	if (type === "request.ended") {
		if (data.outcome === "ok") event.outcome = "ok";
		else if (data.outcome) event.outcome = "error";
		if (typeof data.latencyMs === "number") event.latencyMs = data.latencyMs;
	}
	return event;
}

export interface ProducerPollResult {
	/** complete lines read off the file this poll */
	seen: number;
	/** lines that mapped to plane events and were appended */
	mapped: number;
	accepted: number;
	duplicates: number;
	invalid: number;
	rejectedStaleGeneration: number;
	gaps: number;
}

/**
 * The producer: byte-offset tail of the buckle outbox (complete lines only,
 * rotation-aware) + outbox append + drain into the read model. One instance
 * per (db, outbox path); poll() is the whole cycle.
 */
export class ObservationProducer {
	private offset = 0;

	constructor(
		private readonly db: Database,
		private readonly path: string,
	) {
		// the drain may be the plane's first touch in this process: the read
		// model's tables must exist before the PENDING SELECT runs
		ensureObservationPlane(db);
	}

	async poll(now = Date.now()): Promise<ProducerPollResult> {
		const lines = await this.readNew();
		const result: ProducerPollResult = {
			seen: lines.length,
			mapped: 0,
			accepted: 0,
			duplicates: 0,
			invalid: 0,
			rejectedStaleGeneration: 0,
			gaps: 0,
		};
		for (const line of lines) {
			const event = mapCloudEvent(line);
			if (!event) continue;
			result.mapped += 1;
			appendObservation(this.db, event, now);
		}
		const drained = this.drain(now);
		return { ...result, ...drained };
	}

	/**
	 * Local delivery intent becomes read-model rows: PENDING outbox rows
	 * ingest transactionally, then their rows delete. The ingest's (source,
	 * id) dedup makes the delete-after-ingest window crash-safe: a crash
	 * replays as duplicates, never double-counts. Capacity throws — the
	 * explicit overflow policy (arch doc §5), never silent loss.
	 */
	private drain(now: number): Partial<ProducerPollResult> {
		const rows = this.db
			.query(
				"SELECT payload FROM observation_outbox WHERE status = 'PENDING' ORDER BY rowid",
			)
			.all() as { payload: string }[];
		if (rows.length === 0) return {};
		const events = rows.map((r) => JSON.parse(r.payload));
		const r = ingestObservations(this.db, events, now);
		this.db.run("DELETE FROM observation_outbox WHERE status = 'PENDING'");
		return {
			accepted: r.accepted,
			duplicates: r.duplicates,
			invalid: r.invalid,
			rejectedStaleGeneration: r.rejectedStaleGeneration,
			gaps: r.gaps.length,
		};
	}

	/** Byte-offset tail: only complete lines (a torn crash tail waits in
	 *  the file and is completed by the writer's next append — the offset
	 *  never consumes a partial line), rotation (file smaller than the
	 *  offset) restarts from the head. */
	private async readNew(): Promise<unknown[]> {
		const size = (await stat(this.path).catch(() => null))?.size ?? 0;
		if (size < this.offset) {
			this.offset = 0;
		}
		if (size === this.offset) return [];
		const chunk = await Bun.file(this.path)
			.slice(this.offset)
			.text()
			.catch(() => "");
		if (!chunk) return [];
		const complete = chunk.endsWith("\n")
			? chunk
			: chunk.slice(0, chunk.lastIndexOf("\n") + 1);
		this.offset += complete.length;
		if (!complete) return [];
		return complete
			.split("\n")
			.filter((l) => l.length > 0)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as unknown];
				} catch {
					return []; // torn tail line: skip, never throw
				}
			});
	}
}

/**
 * Board wiring: KLH_OBSERVATION_OUTBOX enables the producer loop; unset
 * returns a disabled handle — no timer, no reads (config-over-code).
 */
export function startObservationPlaneProducer(
	db: Database,
	options: { intervalMs?: number; autoStart?: boolean } = {},
): {
	tick: () => Promise<ProducerPollResult | null>;
	enabled: boolean;
	stop: () => void;
} {
	const path = process.env.KLH_OBSERVATION_OUTBOX;
	if (!path)
		return { tick: async () => null, enabled: false, stop: () => {} };
	const producer = new ObservationProducer(db, path);
	const interval = Math.min(30_000, Math.max(250, options.intervalMs ?? 2_000));
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;
	const tick = async (): Promise<ProducerPollResult | null> => {
		if (stopped) return null;
		try {
			return await producer.poll();
		} catch {
			// capacity overflow is explicit state, not a crash: keep serving
			return null;
		}
	};
	if (options.autoStart !== false) {
		timer = setInterval(() => void tick(), interval);
		timer.unref();
	}
	return {
		tick,
		enabled: true,
		stop: () => {
			stopped = true;
			if (timer) clearInterval(timer);
		},
	};
}
