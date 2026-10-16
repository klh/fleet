// hooks/lib/identity-db.ts — W156 identity plane: users/teams/api_keys/
// auth_events/ceilings are NOT work-graph data. Different lifecycle (the work
// graph is per-project churn; identity is fleet-global, long-lived,
// security-sensitive), independent backup/retention/audit, and the physical
// federation split (identity.db = hub-plane data; governor.db = spoke-plane)
// per the federation doc's Identity plane separation section.
//
//   openIdentityDb()      the identity.db WAL open (openKnowledgeDb shape)
//   migrateIdentitySplit  the v17 move of the identity tables out of
//                         governor.db (the W166 knowledge-split pattern;
//                         main's ladder reached v16 — W603 events shred,
//                         W266.1 supervision plane — before this split ran)
//   identitySqlViolation  the /rpc guard — identity statements must ride the
//                         identity port, never the control-plane store
//
// users/ceilings are named in the doc's identity-plane set but no schema ever
// shipped for them (ceilings live as columns on teams since W210) — the
// migration moves what exists and reserves the names in the guard word list.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { REG } from "./govdb-util.ts";

// the identity.db path derives from the registry dir: govdb passes its own
// (per-instance, temp-HOME-test-safe) REG; the openIdentityDb default rides
// the SAME shared pinned REG openStore()'s local leg uses — one registry,
// both planes.
const idbPath = (regDir: string): string => `${regDir}/identity.db`;

// the identity-plane table names (doc set; users/ceilings reserved — no
// schema shipped for them, nothing to move, the DROP guard still covers a
// stray table if one ever appeared)
const IDENTITY_TABLES = [
	"users",
	"teams",
	"api_keys",
	"auth_events",
	"ceilings",
] as const;

// the identity-plane schemas verbatim from main's governor v8 block
// (pre-split): teams carries the W210 entitlement ceilings, auth_events the
// W451 retention index; the api_keys unique indexes (hash = the one-hash auth
// lookup, jti = the denylist) ride along — indexes do not survive a DROP.
export const IDENTITY_DDL: Record<string, string[]> = {
	teams: [
		"CREATE TABLE IF NOT EXISTS idb.teams (team_id TEXT PRIMARY KEY, name TEXT, department TEXT, created_at INTEGER NOT NULL, rpm_ceiling INTEGER, tpm_ceiling INTEGER, tok_ceiling INTEGER)",
	],
	api_keys: [
		"CREATE TABLE IF NOT EXISTS idb.api_keys (key_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, jti TEXT, name TEXT, team TEXT, actor TEXT, token_type TEXT NOT NULL DEFAULT 'access', parent_key_id TEXT, scopes TEXT, rpm_limit INTEGER, tpm_limit INTEGER, expires_at INTEGER, rotated_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idb.api_keys_hash ON api_keys(key_hash)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idb.api_keys_jti ON api_keys(jti)",
	],
	auth_events: [
		"CREATE TABLE IF NOT EXISTS idb.auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, event TEXT NOT NULL, jti TEXT, via TEXT)",
		"CREATE INDEX IF NOT EXISTS idb.auth_events_ts ON auth_events(ts)",
	],
};

// v17 statement table — the whole move is a fixed, reviewable list:
// idb side (CREATE + copy preserving every column and the auth_events ids),
// then main side (DROP — the deltas triggers on these tables go with them).
// Trigger bodies may NOT schema-qualify (SQLite forbids cross-db references
// inside a trigger) — the idb.name prefix registers in idb; unqualified ON
// names resolve there. `copy` rides ONLY into an empty idb (idb wins on
// reset); split-brain (both sides hold rows) refuses loudly in the fn below.
const IDENTITY_SPLIT_V17 = (copy: boolean): string[] => [
	...Object.values(IDENTITY_DDL).flat(),
	...(copy
		? [
				"INSERT INTO idb.api_keys (key_id, key_hash, jti, name, team, actor, token_type, parent_key_id, scopes, rpm_limit, tpm_limit, expires_at, rotated_at, revoked_at, created_at) SELECT key_id, key_hash, jti, name, team, actor, token_type, parent_key_id, scopes, rpm_limit, tpm_limit, expires_at, rotated_at, revoked_at, created_at FROM main.api_keys ORDER BY key_id",
				"INSERT INTO idb.teams (team_id, name, department, created_at, rpm_ceiling, tpm_ceiling, tok_ceiling) SELECT team_id, name, department, created_at, rpm_ceiling, tpm_ceiling, tok_ceiling FROM main.teams ORDER BY team_id",
				"INSERT INTO idb.auth_events (id, ts, actor, event, jti, via) SELECT id, ts, actor, event, jti, via FROM main.auth_events ORDER BY id",
			]
		: []),
	"DROP TABLE IF EXISTS main.users",
	"DROP TABLE IF EXISTS main.teams",
	"DROP TABLE IF EXISTS main.api_keys",
	"DROP TABLE IF EXISTS main.auth_events",
	"DROP TABLE IF EXISTS main.ceilings",
];

// existence-guarded row counts: a fresh DB never held identity tables (the
// v8 CREATEs are gone with this same change), so COUNT(*) would throw there;
// and the idb side may be absent entirely (first split). Quality: count ONLY
// the doc's five names, main-qualified.
function idbCountRows(db: Database, qual: string): number {
	return IDENTITY_TABLES.map((t) =>
		Number(
			(
				db
					.query(
						`SELECT COUNT(*) AS n FROM ${qual}.sqlite_master WHERE type = 'table' AND name = '${t}'`,
					)
					.get() as { n: number }
			).n,
		) > 0
			? Number(
					(
						db.query(`SELECT COUNT(*) AS n FROM ${qual}.${t}`).get() as {
							n: number;
						}
					).n,
				)
			: 0,
	).reduce((a, b) => a + b, 0);
}

// W156: the identity tables leave governor.db (uv < 17) — one transaction
// across main + attached idb; a crash rolls back, uv stays < 17, and the next
// open retries. The pre-migration VACUUM INTO of governor.db (identity rows
// still resident) is the rollback anchor.
export function migrateIdentitySplit(db: Database, regDir: string): void {
	db.run("ATTACH DATABASE ? AS idb", [idbPath(regDir)]);
	const mainN = idbCountRows(db, "main");
	const idbN = idbCountRows(db, "idb");
	// split-brain refusal: both files holding identity rows is not a state a
	// migration may guess its way out of — name the pre-split backups instead.
	if (idbN > 0 && mainN > 0)
		throw new Error(
			"identity split (v17): governor.db AND identity.db both hold identity rows — resolve manually (pre-split snapshots: governor-pre-identity-split-*)",
		);
	if (mainN > 0) {
		let bak = `${regDir}/governor-pre-identity-split-${Date.now()}.db`;
		for (let i = 1; existsSync(bak); i++)
			bak = `${regDir}/governor-pre-identity-split-${Date.now()}-${i}`;
		db.run(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
		console.error(
			`[govdb] v17 pre-migration backup: ${bak} (${mainN} identity rows)`,
		);
	}
	db.run("BEGIN IMMEDIATE");
	try {
		// copy only when idb is empty AND main actually held rows — a fresh DB
		// has neither (the v8 CREATEs are gone), so the SELECTs must not run.
		for (const sql of IDENTITY_SPLIT_V17(idbN === 0 && mainN > 0)) db.run(sql);
		db.run("PRAGMA user_version = 17");
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(
					`govdb identity split (v17) failed, rolled back: ${e.message}`,
					{ cause: e },
				)
			: e;
	}
	db.run("VACUUM"); // freed pages returned (outside the tx, W166 pattern)
	db.run("DETACH DATABASE idb");
}

// /rpc guard, knowledgeSqlViolation shape: string literals stripped first —
// events LIKE 'api_keys.%' and deltas tbl='teams' are legit control-plane SQL
// over the WORD, never the table. Covers the doc's full identity-plane set,
// including the reserved users/ceilings names.
export function identitySqlViolation(sql: string): string | null {
	const bare = sql
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""');
	const m = /\b(api_keys|teams|auth_events|users|ceilings)\b/.exec(bare);
	return m ? m[0] : null;
}

// the identity.db WAL open — openKnowledgeDb's shape (busy_timeout BEFORE
// journal_mode; WAL-throw on failure), minus mmap/page_size: small file, no
// FTS hot path.
export function openIdentityDb(regDir = REG()): Database {
	mkdirSync(regDir, { recursive: true });
	const db = new Database(idbPath(regDir), { create: true });
	db.run("PRAGMA busy_timeout=2000");
	try {
		db.run("PRAGMA journal_mode=WAL");
	} catch {
		const mode = (
			db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
		)?.journal_mode;
		if (mode?.toLowerCase() !== "wal")
			throw new Error(
				`identity.db WAL unavailable (got: ${mode ?? "unknown"})`,
			);
	}
	db.run("PRAGMA synchronous=NORMAL");
	return db;
}
