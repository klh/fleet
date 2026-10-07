import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

type Manifest = {
	version: number;
	backup: string;
	report: string;
	backupHash: string;
	reportHash: string;
};
const hash = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const legacyRows = (db: Database) =>
	JSON.stringify(
		db
			.query("SELECT * FROM usage_rollup ORDER BY hour_bucket,actor,model")
			.all(),
	);

/** Explicit migration of a caller-owned DB, never invoked by page rendering.
 * All legacy rows remain intact; report activation is reversible independently
 * of the new source data. Snapshot hashes and stale-base check precede mutation. */
export function activateTranscriptUsage(
	db: Database,
	manifestPath: string,
	intent?: { reviewedSourceSelection: true },
): void {
	if (intent?.reviewedSourceSelection !== true)
		throw new Error(
			"usage migration: explicit reviewed source-selection intent required",
		);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	if (manifest.version !== 2 || !manifest.backupHash || !manifest.reportHash)
		throw new Error("usage migration: missing verified backup manifest");
	if (hash(readFileSync(manifest.backup)) !== manifest.backupHash)
		throw new Error("usage migration: backup hash mismatch");
	const backup = new Database(manifest.backup, { readonly: true });
	const report = new Database(manifest.report, { readonly: true });
	try {
		if (hash(report.serialize()) !== manifest.reportHash)
			throw new Error("usage migration: report hash mismatch");
		db.run("BEGIN IMMEDIATE");
		try {
			const exists = db
				.query(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_migration_state'",
				)
				.get();
			if (exists) {
				const state = db
					.query("SELECT manifest_hash FROM usage_migration_state WHERE id=1")
					.get() as { manifest_hash: string } | null;
				if (state?.manifest_hash === manifest.reportHash) {
					db.run("UPDATE usage_migration_state SET active=1 WHERE id=1");
					db.run("COMMIT");
					return;
				}
				throw new Error("usage migration: another migration already exists");
			}
			if (legacyRows(db) !== legacyRows(backup))
				throw new Error(
					"usage migration: stale legacy aggregate snapshot; prepare again",
				);
			db.run(
				"CREATE TABLE usage_rollup_legacy_archive AS SELECT * FROM usage_rollup",
			);
			db.run(
				"CREATE TRIGGER usage_archive_insert BEFORE INSERT ON usage_rollup_legacy_archive BEGIN SELECT RAISE(ABORT,'legacy usage archive is immutable'); END",
			);
			db.run(
				"CREATE TRIGGER usage_archive_update BEFORE UPDATE ON usage_rollup_legacy_archive BEGIN SELECT RAISE(ABORT,'legacy usage archive is immutable'); END",
			);
			db.run(
				"CREATE TRIGGER usage_archive_delete BEFORE DELETE ON usage_rollup_legacy_archive BEGIN SELECT RAISE(ABORT,'legacy usage archive is immutable'); END",
			);
			const schema = report
				.query("SELECT sql FROM sqlite_master WHERE name='usage_rollup'")
				.get() as { sql: string };
			db.run(schema.sql.replace(/usage_rollup/, "usage_verified_rollup"));
			db.run(
				"ALTER TABLE usage_verified_rollup ADD COLUMN producer TEXT NOT NULL DEFAULT 'transcript-v2' CHECK(producer='transcript-v2')",
			);
			const insert = db.query(
				"INSERT INTO usage_verified_rollup (hour_bucket,actor,model,model_group,in_tok,out_tok,cache_r,cache_c,requests) VALUES (?,?,?,?,?,?,?,?,?)",
			);
			for (const row of report
				.query("SELECT * FROM usage_rollup")
				.iterate() as Iterable<Record<string, string | number | null>>)
				insert.run(
					row.hour_bucket,
					row.actor,
					row.model,
					row.model_group,
					row.in_tok,
					row.out_tok,
					row.cache_r,
					row.cache_c,
					row.requests,
				);
			const ledgerSchema = report
				.query(
					"SELECT sql FROM sqlite_master WHERE name='usage_message_ledger'",
				)
				.get() as { sql: string };
			// Cached legacy producers keep their ledger and aggregate. They must
			// never consume deltas belonging to the verified source.
			db.run(
				ledgerSchema.sql.replace(
					/usage_message_ledger/,
					"usage_verified_message_ledger",
				),
			);
			const ledger = db.query(
				"INSERT INTO usage_verified_message_ledger VALUES (?,?,?,?,?,?,?,?,?)",
			);
			for (const row of report
				.query("SELECT * FROM usage_message_ledger")
				.iterate() as Iterable<Record<string, string | number | null>>)
				ledger.run(
					row.source,
					row.message_id,
					row.hour_bucket,
					row.actor,
					row.model,
					row.in_tok,
					row.out_tok,
					row.cache_r,
					row.cache_c,
				);
			// W466: the rebuilt store keeps cursors in machine_cursors (govdb
			// v12); pre-W466 report artifacts kept them in facts — read both.
			db.run(
				"CREATE TABLE IF NOT EXISTS machine_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL)",
			);
			const cursor = db.query(
				"INSERT INTO machine_cursors (key,value,source,ts) VALUES (?,?,'usage-v2-migration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,ts=excluded.ts",
			);
			const reportHasCursorTable = report
				.query(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='machine_cursors'",
				)
				.get();
			const cursorRows = report
				.query(
					reportHasCursorTable
						? "SELECT key,value FROM machine_cursors WHERE key LIKE 'usage.tp.%'"
						: "SELECT key,value FROM facts WHERE key LIKE 'usage.tp.%'",
				)
				.iterate() as Iterable<{ key: string; value: string }>;
			for (const row of cursorRows)
				cursor.run(
					row.key.replace("usage.tp.", "usage.v2.tp."),
					row.value,
					Date.now(),
				);
			db.run(
				"CREATE TABLE usage_migration_state (id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL,manifest_hash TEXT NOT NULL,backup_path TEXT NOT NULL,applied_at INTEGER NOT NULL)",
			);
			db.query("INSERT INTO usage_migration_state VALUES (1,1,?,?,?)").run(
				manifest.reportHash,
				manifest.backup,
				Date.now(),
			);
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	} finally {
		backup.close();
		report.close();
	}
}

/** Hide verified metrics without deleting any source or historical data. */
export function deactivateTranscriptUsage(db: Database): void {
	db.run("UPDATE usage_migration_state SET active=0 WHERE id=1");
}
