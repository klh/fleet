import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	addThroughputSample,
	assertThroughputPolicy,
	evaluateThroughput,
	throughputKey,
	DEFAULT_THROUGHPUT_POLICY,
	type ThroughputSample,
	type ThroughputBucket,
	type ThroughputBaseline,
	type ThroughputPolicy,
} from "./throughput.ts";

/** Same Buckle SQLite/WAL and flush transaction, no second daemon or store.
 * Samples deduplicate within a node; totals across hops MUST use trace/call
 * identity, never sum these explicitly node-local counters. */
export class ThroughputStore {
	constructor(
		private readonly db: Database,
		readonly policy: ThroughputPolicy = DEFAULT_THROUGHPUT_POLICY,
	) {
		assertThroughputPolicy(policy);
		db.exec(`CREATE TABLE IF NOT EXISTS throughput_seen(id TEXT PRIMARY KEY,bucket INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS throughput_seen_bucket ON throughput_seen(bucket);
		CREATE TABLE IF NOT EXISTS throughput_bucket(node TEXT NOT NULL,bucket INTEGER NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(node,bucket,key));
		CREATE TABLE IF NOT EXISTS throughput_baseline(node TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(node,key));
		CREATE TABLE IF NOT EXISTS throughput_capacity(node TEXT NOT NULL,bucket INTEGER NOT NULL,dropped INTEGER NOT NULL,PRIMARY KEY(node,bucket));
		CREATE TABLE IF NOT EXISTS throughput_incident(id TEXT PRIMARY KEY,node TEXT NOT NULL,key TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,body TEXT NOT NULL);`);
	}

	observe(s: ThroughputSample): "recorded" | "duplicate" | "capacity" {
		for (const value of [
			s.id,
			s.node,
			s.requestedGroup,
			s.model,
			s.provider,
			s.providerProfile,
			s.effort,
			s.context,
		])
			if (value !== null && (typeof value !== "string" || value.length > 256))
				throw new Error("throughput: invalid identity");
		for (const value of [
			s.at,
			s.attempts,
			s.totalMs,
			s.queueMs,
			s.serviceMs,
			s.outTokens,
		])
			if (value !== null && (!Number.isFinite(value) || value < 0))
				throw new Error("throughput: invalid measurement");
		const p = this.policy,
			bucket = Math.floor(s.at / p.bucketMs) * p.bucketMs,
			key = throughputKey(s);
		return this.db.transaction(() => {
			const sampleId = JSON.stringify([s.node, s.id]);
			if (
				this.db.query("SELECT 1 FROM throughput_seen WHERE id=?").get(sampleId)
			)
				return "duplicate" as const;
			this.db
				.query("DELETE FROM throughput_seen WHERE bucket<?")
				.run(bucket - p.retentionBuckets * p.bucketMs);
			this.db
				.query(
					"DELETE FROM throughput_baseline WHERE json_extract(body,'$.lastBucket')<?",
				)
				.run(bucket - p.retentionBuckets * p.bucketMs);
			this.db
				.query("DELETE FROM throughput_capacity WHERE bucket<?")
				.run(bucket - p.retentionBuckets * p.bucketMs);
			this.db
				.query("DELETE FROM throughput_incident WHERE started<?")
				.run(bucket - p.retentionBuckets * p.bucketMs);
			this.db
				.query("DELETE FROM throughput_bucket WHERE bucket<?")
				.run(bucket - p.retentionBuckets * p.bucketMs);
			const seen = this.db
				.query("SELECT count(*) AS n FROM throughput_seen WHERE bucket=?")
				.get(bucket) as { n: number };
			const existing = this.db
				.query(
					"SELECT body FROM throughput_bucket WHERE node=? AND bucket=? AND key=?",
				)
				.get(s.node, bucket, key) as { body: string } | null;
			const dimensions = this.db
				.query(
					"SELECT count(DISTINCT key) AS n FROM throughput_bucket WHERE node=?",
				)
				.get(s.node) as { n: number };
			const known =
				existing ||
				this.db
					.query(
						"SELECT 1 FROM throughput_bucket WHERE node=? AND key=? LIMIT 1",
					)
					.get(s.node, key);
			if (
				seen.n >= p.maxSamplesPerBucket ||
				(!known && dimensions.n >= p.maxDimensions)
			) {
				this.noteCapacity(s.node, bucket);
				return "capacity" as const;
			}
			const next = addThroughputSample(
				existing ? JSON.parse(existing.body) : null,
				s,
				p,
			);
			this.db
				.query("INSERT INTO throughput_seen(id,bucket) VALUES (?,?)")
				.run(sampleId, bucket);
			this.db
				.query(
					"INSERT INTO throughput_bucket(node,bucket,key,body) VALUES (?,?,?,?) ON CONFLICT(node,bucket,key) DO UPDATE SET body=excluded.body",
				)
				.run(s.node, bucket, key, JSON.stringify(next));
			return "recorded" as const;
		})();
	}

	/** Sealed windows only; a read is repeatable and never trains twice.
	 * The consumer owns incident publication, using the returned transition. */
	snapshot(now: number) {
		const p = this.policy;
		const rows = this.db
			.query(
				"SELECT body FROM throughput_bucket WHERE bucket>=? ORDER BY bucket,node,key",
			)
			.all(now - p.retentionBuckets * p.bucketMs) as { body: string }[];
		return this.db.transaction(() =>
			rows.map((row) => {
				const bucket = JSON.parse(row.body) as ThroughputBucket;
				bucket.saturated = !!this.db
					.query("SELECT 1 FROM throughput_capacity WHERE node=? AND bucket=?")
					.get(bucket.node, bucket.bucket);
				const previous = this.db
					.query("SELECT body FROM throughput_baseline WHERE node=? AND key=?")
					.get(bucket.node, bucket.key) as { body: string } | null;
				const result = evaluateThroughput(
					bucket,
					previous ? (JSON.parse(previous.body) as ThroughputBaseline) : null,
					p,
					now,
				);
				if (result.baseline)
					this.db
						.query(
							"INSERT INTO throughput_baseline(node,key,body) VALUES (?,?,?) ON CONFLICT(node,key) DO UPDATE SET body=excluded.body",
						)
						.run(bucket.node, bucket.key, JSON.stringify(result.baseline));
				if (result.transition === "warning") {
					const id = createHash("sha256")
						.update(JSON.stringify([bucket.node, bucket.key, bucket.bucket]))
						.digest("hex")
						.slice(0, 32);
					this.db
						.query(
							"INSERT OR IGNORE INTO throughput_incident(id,node,key,started,ended,body) VALUES (?,?,?,?,NULL,?)",
						)
						.run(
							id,
							bucket.node,
							bucket.key,
							bucket.bucket,
							JSON.stringify({
								bucket,
								rate: result.rate,
								reference: result.baseline?.rate,
								ratio: result.ratio,
							}),
						);
				} else if (result.transition === "recovery")
					this.db
						.query(
							"UPDATE throughput_incident SET ended=? WHERE node=? AND key=? AND ended IS NULL",
						)
						.run(bucket.bucket, bucket.node, bucket.key);
				return { scope: "node_local" as const, bucket, ...result };
			}),
		)();
	}

	incidents() {
		return this.db
			.query(
				"SELECT id,node,key,started,ended,body FROM throughput_incident ORDER BY ended IS NULL DESC,started DESC LIMIT ?",
			)
			.all(this.policy.maxDimensions) as Array<{
			id: string;
			node: string;
			key: string;
			started: number;
			ended: number | null;
			body: string;
		}>;
	}

	/** Collection refusals are not provider errors or distinct request counts. */
	noteCapacity(node: string, bucket: number): void {
		this.db
			.query(
				"INSERT INTO throughput_capacity(node,bucket,dropped) VALUES (?,?,1) ON CONFLICT(node,bucket) DO UPDATE SET dropped=dropped+1",
			)
			.run(node, bucket);
	}
	capacitySignals(now: number) {
		return this.db
			.query(
				"SELECT node,bucket,dropped FROM throughput_capacity WHERE bucket>=? ORDER BY bucket DESC LIMIT ?",
			)
			.all(
				now - this.policy.retentionBuckets * this.policy.bucketMs,
				this.policy.retentionBuckets,
			) as Array<{ node: string; bucket: number; dropped: number }>;
	}
}
