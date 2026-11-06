// src/gov/schema.ts — W141 governance tables in the buckle ledger DB:
// govdb v8 shapes verbatim (hooks/lib/govdb/govdb.ts W132 block) so the W92
// openStore binding swap moves statements as-is, PLUS the deltas mirror —
// the audit trail IS the deltas log (W132 doctrine), so the same trigger
// loop govdb runs is created here over the local tables. Team ceilings ride
// guarded ALTERs (house idempotent pattern).
import type { Database } from "bun:sqlite";
import { ensureChainColumns } from "./audit-chain.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  jti TEXT,
  name TEXT,
  team TEXT,
  actor TEXT,
  token_type TEXT NOT NULL DEFAULT 'access',
  parent_key_id TEXT,
  scopes TEXT,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  expires_at INTEGER,
  rotated_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys(key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_jti ON api_keys(jti);
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT,
  department TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_state (
  key_id TEXT NOT NULL,
  window TEXT NOT NULL,
  used_rpm INTEGER NOT NULL DEFAULT 0,
  used_tpm INTEGER NOT NULL DEFAULT 0,
  cache_r INTEGER NOT NULL DEFAULT 0,
  cache_c INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (key_id, window)
);
CREATE TABLE IF NOT EXISTS team_budget_state (
  team_id TEXT NOT NULL,
  window TEXT NOT NULL,
  used_rpm INTEGER NOT NULL DEFAULT 0,
  used_tpm INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (team_id, window)
);
-- W843 bounded spend policy: the token-denominated spend book. The
-- authority behind the team spend ceiling (teams.spend_ceiling);
-- currency limits stay evidence-gated (provider billing), never faked.
CREATE TABLE IF NOT EXISTS spend_state (
  subject TEXT PRIMARY KEY,
  used_tok INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- W2790 per-key monthly token budgets: one row per budgeted subject (mint
-- name, prefix*, or actor:<id>) - absent = unlimited (lanes keep working;
-- this is for shared/employee-facing deployments). weights = per-model-
-- group multipliers (JSON, default 1).
CREATE TABLE IF NOT EXISTS token_budgets (
  subject TEXT PRIMARY KEY,
  monthly_tokens INTEGER NOT NULL,
  weights TEXT NOT NULL DEFAULT "{}",
  updated_at INTEGER NOT NULL
);
-- W2790 the monthly book: post-reservation sums per (month, subject) -
-- admission reserves the weighted input estimate, settle adds the real
-- usage (W843 errs-high doctrine). Rows exist ONLY for budgeted subjects.
CREATE TABLE IF NOT EXISTS token_budget_state (
  month TEXT NOT NULL,
  subject TEXT NOT NULL,
  used_tok INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month, subject)
);
CREATE TABLE IF NOT EXISTS admission_slots (
  scope TEXT PRIMARY KEY,
  held INTEGER NOT NULL DEFAULT 0,
  touched INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admission_slot_holders (
  scope TEXT NOT NULL,
  holder TEXT NOT NULL,
  touched INTEGER NOT NULL,
  PRIMARY KEY (scope, holder)
);
CREATE INDEX IF NOT EXISTS admission_slot_holders_touched
  ON admission_slot_holders(touched);
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,
  event TEXT NOT NULL,
  jti TEXT,
  via TEXT
);
-- W233: federation_spokes + federation_enrollment_codes DDL moved to the
-- enterprise overlay hub schema — solo posture
-- never holds a fleet registry.
-- W233.2: federation_usage_rollup + federation_aid_rollup DDL moved to the
-- enterprise overlay hub schema — solo posture
-- never holds a fleet-wide rollup store.
-- W233.3: the federation_cr_queue DDL moved to the enterprise overlay
-- hub schema — solo posture never holds a CR
-- queue; the manifest/CR serving rides the ManifestCrProvider seam.
`;

/** (table, pk-expression, columns) — mirrors the govdb deltaTables entries. */
const DELTA_TABLES: Array<{ tbl: string; pk: string; cols: string[] }> = [
	{
		tbl: "api_keys",
		pk: "$.key_id",
		cols: [
			"key_id",
			"key_hash",
			"jti",
			"name",
			"team",
			"actor",
			"token_type",
			"parent_key_id",
			"scopes",
			"rpm_limit",
			"tpm_limit",
			"expires_at",
			"rotated_at",
			"revoked_at",
			"created_at",
		],
	},
	{
		tbl: "teams",
		pk: "$.team_id",
		cols: ["team_id", "name", "department", "created_at"],
	},
	{
		tbl: "budget_state",
		pk: "$.key_id || '/' || $.window",
		cols: [
			"key_id",
			"window",
			"used_rpm",
			"used_tpm",
			"cache_r",
			"cache_c",
			"window_start",
		],
	},
	{
		tbl: "auth_events",
		pk: "$.id",
		cols: ["id", "ts", "actor", "event", "jti", "via"],
	},
	{
		tbl: "spend_state",
		pk: "$.subject",
		cols: ["subject", "used_tok", "updated_at"],
	},
	// W233.3: the federation_cr_queue delta entry moved with the DDL —
	// the overlay hub schema owns the CR queue deltas.
];

/** One deltas trigger (same shape as govdb's loop emits). */
function deltasTriggerSql(
	tbl: string,
	pk: string,
	cols: string[],
	op: "insert" | "update" | "delete",
): string {
	const R = op === "delete" ? "OLD" : "NEW";
	const img = (side: "OLD" | "NEW"): string =>
		`json_object(${cols.map((c) => `'${c}', ${side}.${c}`).join(", ")})`;
	const before = op === "insert" ? "NULL" : img("OLD");
	const after = op === "delete" ? "NULL" : img("NEW");
	return `CREATE TRIGGER IF NOT EXISTS deltas_${tbl}_${op} AFTER ${op.toUpperCase()} ON ${tbl} BEGIN INSERT INTO deltas (ts, tbl, op, pk, before, after) VALUES (strftime('%s','now') * 1000, '${tbl}', '${op}', ${pk.replaceAll("$.", `${R}.`)}, ${before}, ${after}); END`;
}

export function applyGovernanceSchema(db: Database): void {
	db.exec(SCHEMA_SQL);
	// the deltas mirror table (govdb has it; the local ledger needs its own)
	db.exec(
		"CREATE TABLE IF NOT EXISTS deltas (ts INTEGER NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT NOT NULL, before TEXT, after TEXT)",
	);
	// W703: hash-chain columns on auth_events (pre-chain databases heal)
	ensureChainColumns(db);
	// team ceilings (W141) — guarded ALTERs, idempotent on every open
	const cols = (
		db.query("SELECT name FROM pragma_table_info('teams')").all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
	if (!cols.includes("rpm_ceiling"))
		db.run("ALTER TABLE teams ADD COLUMN rpm_ceiling INTEGER");
	if (!cols.includes("tpm_ceiling"))
		db.run("ALTER TABLE teams ADD COLUMN tpm_ceiling INTEGER");
	// W843 team spend ceiling — lifetime token-denominated cap (guarded
	// ALTER, idempotent per open; NULL = unbounded)
	if (!cols.includes("spend_ceiling"))
		db.run("ALTER TABLE teams ADD COLUMN spend_ceiling INTEGER");
	// W457 cache telemetry — guarded ALTERs (pre-cache budget_state heals)
	const budgetCols = (
		db
			.query("SELECT name FROM pragma_table_info('budget_state')")
			.all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
	if (!budgetCols.includes("cache_r"))
		db.run(
			"ALTER TABLE budget_state ADD COLUMN cache_r INTEGER NOT NULL DEFAULT 0",
		);
	if (!budgetCols.includes("cache_c"))
		db.run(
			"ALTER TABLE budget_state ADD COLUMN cache_c INTEGER NOT NULL DEFAULT 0",
		);
	// W233.3: the W160 CR origination column migrations moved with the DDL —
	// the overlay hub schema heals its own table.
	// the deltas mirror — guarded CREATEs, self-healing on every open
	for (const { tbl, pk, cols } of DELTA_TABLES)
		for (const op of ["insert", "update", "delete"] as const)
			db.run(deltasTriggerSql(tbl, pk, cols, op));
}
