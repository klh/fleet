import { Database } from "bun:sqlite";
import { seedUsage } from "../bin/usage-seed.ts";

const cache = new WeakMap<Database, { at: number; actors: string[] }>();
/** Legacy seeds lost their session rows during session retention. Admit only
 * an exact match to the canonical deterministic seed, never a name prefix. */
export function verifiedLegacySeedActors(db: Database): string[] {
	const previous = cache.get(db);
	if (previous && Date.now() - previous.at < 60_000) return previous.actors;
	const actual = db
		.query(
			"SELECT * FROM usage_rollup WHERE actor IN ('demo:alice@demo', 'demo:bob@demo') ORDER BY hour_bucket, actor, model LIMIT 3366",
		)
		.all() as Record<string, unknown>[];
	// Canonical maximum: 673 hourly buckets × five seeded model rows. One
	// extra row disproves seed identity without reading unbounded history.
	if (actual.length < 100 || actual.length > 3365) return [];
	const max = actual.reduce(
		(latest, r) => Math.max(latest, Number(r.hour_bucket)),
		0,
	);
	const candidate = new Database(":memory:");
	try {
		candidate.run(
			"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER, hb INTEGER, state TEXT, actor TEXT, tags TEXT)",
		);
		candidate.run(
			"CREATE TABLE usage_rollup (hour_bucket INTEGER, actor TEXT, model TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER, PRIMARY KEY(hour_bucket, actor, model))",
		);
		seedUsage(candidate, { nowMs: max });
		const expected = candidate
			.query("SELECT * FROM usage_rollup ORDER BY hour_bucket, actor, model")
			.all();
		const verified = JSON.stringify(actual) === JSON.stringify(expected);
		const actors = verified ? ["demo:alice@demo", "demo:bob@demo"] : [];
		if (verified) {
			// Metadata is additive. No sessions or metering rows are rewritten.
			try {
				db.run(
					"CREATE TABLE IF NOT EXISTS usage_actor_provenance (actor TEXT PRIMARY KEY, source TEXT NOT NULL, verified_at INTEGER NOT NULL)",
				);
				for (const actor of actors)
					db.query(
						"INSERT OR REPLACE INTO usage_actor_provenance VALUES (?, 'usage-seed:exact-v1', ?)",
					).run(actor, Date.now());
			} catch {
				/* A read-only report can still verify provenance in memory. */
			}
		}
		cache.set(db, { at: Date.now(), actors });
		return actors;
	} finally {
		candidate.close();
	}
}
