// src/observe.ts — W461 stage 2: minimal unsampled lane observations.
// Admitted/started/ended events per proxied request, published
// independent of trace sampling (upstream-observability-architecture.md
// §2). CloudEvents 1.0.2 envelope: equal source+id is a duplicate, so the
// id is the observer's monotonic per-boot sequence and the source names
// hub + boot epoch — a restarted observer reports a new epoch without
// changing lane identity. Durable outbox first (bounded NDJSON file with
// explicit rotation): a broker lands only on measured need (doc §2).
import { appendFile, rename, stat, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type ObservationType =
	| "lane.request.admitted"
	| "lane.request.started"
	| "lane.request.ended";

/** Per-request observation payload — correlation fields from the W461.1
 *  trace context; accounting usage deliberately excluded (billing rides
 *  the ledger, doc §5). */
export interface ObservationData {
	rid: string;
	lane: string;
	actor: string;
	dialect: string;
	model: string;
	traceparent: string;
	outcome?: string;
	status?: number;
	attempts?: number;
}

/** CloudEvents 1.0.2-shaped observation (the subset the ingest needs). */
export interface Observation {
	specversion: "1.0";
	type: ObservationType;
	source: string;
	id: string;
	time: string;
	data: ObservationData;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Bounded NDJSON outbox: one writer, bounded in-flight queue, explicit
 *  overflow policy (drop-oldest counting, never silent). Absent path =
 *  construction refused — the caller stays inert (config-over-code). */
export class ObservationOutbox {
	readonly source: string;
	private readonly path: string;
	private readonly maxBytes: number;
	private seq = 0;
	private rotations = 0;
	private dropped = 0;
	private pending: string[] = [];
	private writing = false;
	private bytes = -1;

	constructor(opts: {
		path: string;
		hubId?: string;
		maxBytes?: number;
		bootId?: string;
	}) {
		this.path = opts.path;
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		// hub + boot epoch: dedup-stable within a boot, epoch-visible across
		// restarts (gap detection at the ingest)
		this.source = `buckle://${opts.hubId ?? "local"}/${opts.bootId ?? randomBytes(8).toString("hex")}`;
		mkdirSync(dirname(opts.path), { recursive: true });
	}

	/** Queue one observation. The envelope id is the per-boot sequence —
	 *  monotonic, gap-detecting, dedup-stable. */
	emit(type: ObservationType, data: ObservationData): void {
		this.seq++;
		const obs: Observation = {
			specversion: "1.0",
			type,
			source: this.source,
			id: String(this.seq),
			time: new Date().toISOString(),
			data,
		};
		if (this.pending.length >= 1024) {
			this.pending.shift();
			this.dropped++;
		}
		this.pending.push(JSON.stringify(obs));
		void this.flush();
	}

	stats(): { seq: number; rotations: number; dropped: number } {
		return { seq: this.seq, rotations: this.rotations, dropped: this.dropped };
	}

	/** Drain the queue to the file; single-flight (backpressure by bound). */
	private async flush(): Promise<void> {
		if (this.writing) return;
		this.writing = true;
		try {
			while (this.pending.length > 0) {
				const line = `${this.pending.shift()}\n`;
				if (this.bytes < 0) {
					const st = await stat(this.path).catch(() => null);
					this.bytes = st?.size ?? 0;
				}
				if (this.bytes + line.length > this.maxBytes) {
					// bounded persistence: one prior generation kept, then gone —
					// the outbox is NOT durable beyond its failure domain (doc §2)
					await unlink(`${this.path}.1`).catch(() => {});
					await rename(this.path, `${this.path}.1`).catch(() => {});
					this.rotations++;
					this.bytes = 0;
				}
				await appendFile(this.path, line);
				this.bytes += line.length;
			}
		} catch {
			// the outbox never takes inference traffic down with it
		} finally {
			this.writing = false;
		}
	}

	/** Read observations for the ingest, oldest generation first. Used by
	 *  the stage-3 projection; dedup keys on source+id at the ingest. */
	static async read(path: string): Promise<Observation[]> {
		const parse = (text: string): Observation[] =>
			text
				.split("\n")
				.filter((l) => l.length > 0)
				.flatMap((l) => {
					try {
						const o = JSON.parse(l) as Observation;
						return o.specversion === "1.0" ? [o] : [];
					} catch {
						return []; // a torn tail line after a crash: skip, never throw
					}
				});
		const prior = await Bun.file(`${path}.1`)
			.text()
			.catch(() => "");
		const current = await Bun.file(path)
			.text()
			.catch(() => "");
		return [...parse(prior), ...parse(current)];
	}
}
