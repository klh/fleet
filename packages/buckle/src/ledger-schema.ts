// src/ledger-schema.ts — the route_audit/router_usage/route_attempt
// schema + the idempotent heal ladder, extracted from ledger.ts (W2256:
// the 1389-line pin demanded decomposition; statements are byte-identical).
// Law: every new column heals onto existing DBs via pragma-checked ALTER —
// opening a pre-column database must never lose a row.

import type { Database } from "bun:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS router_usage (
  hour_bucket TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  model_group TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  cache_r INTEGER NOT NULL DEFAULT 0,
  cache_c INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  rate_version TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hour_bucket, key, model_group, model)
);
CREATE TABLE IF NOT EXISTS route_audit (
  rid TEXT PRIMARY KEY,
	trace_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT '',
  dialect TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  candidates_top TEXT NOT NULL DEFAULT '',
  target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT,
  decision TEXT NOT NULL DEFAULT '',
  latency_class TEXT NOT NULL DEFAULT 'unproven',
  tier TEXT NOT NULL DEFAULT '',
  allow_cloud INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  why TEXT NOT NULL DEFAULT '',
  status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT,
  attempts INTEGER,
  cache_r INTEGER, cache_c INTEGER, cache_reported INTEGER,
  cache_c_reported INTEGER,
  in_tok INTEGER, out_tok INTEGER,
  cost_usd REAL,
  rate_version TEXT NOT NULL DEFAULT '',
  hop TEXT,
  traffic_kind TEXT,
  repo_hash TEXT, account_tier TEXT, key_name TEXT,
  request_path TEXT, allow_cross INTEGER, provider_pin TEXT
);
CREATE TABLE IF NOT EXISTS route_attempt (
  rid TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  service TEXT NOT NULL,
  hop TEXT NOT NULL,
  candidate TEXT NOT NULL,
  status INTEGER,
  refusal TEXT,
  layer TEXT,
  duration_ms INTEGER NOT NULL,
  retry_after_ms INTEGER,
  upstream_id TEXT,
  call_id TEXT,
	upstream_refusal_code TEXT,
	refusal_origin TEXT,
	provider_pool TEXT,
	queue_wait_ms INTEGER,
	provider_error_code TEXT,
	provider_error_type TEXT,
	transport_json TEXT,
  PRIMARY KEY (rid, ordinal)
);
CREATE INDEX IF NOT EXISTS route_attempt_trace ON route_attempt(trace_id, ts);
CREATE TABLE IF NOT EXISTS stream_settle (
  rid TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  first_byte_ms INTEGER,
  last_byte_ms INTEGER,
  closer TEXT NOT NULL,
  failure_kind TEXT
);
CREATE INDEX IF NOT EXISTS stream_settle_trace ON stream_settle(trace_id, ts);
`;

/** The idempotent heal ladder (W2256 extraction): pragma-checked ALTERs —
 *  a missing column means the schema predates it, never a fatal open. */
export function migrateLedgerSchema(db: Database): void {
	db.exec(SCHEMA);
	// W1: pre-lane databases keep their table (CREATE IF NOT EXISTS won't
	// add the column) — ALTER it in; a duplicate column just means the
	// schema is already current.
	try {
		db.exec("ALTER TABLE route_audit ADD COLUMN lane TEXT NOT NULL DEFAULT ''");
	} catch {
		// column exists — schema current
	}
	// W457: cache telemetry columns (pre-cache databases heal; one ALTER
	// per missing column, checked via pragma — idempotent on every open).
	const auditCols = (
		db
			.query("SELECT name FROM pragma_table_info('route_audit')")
			.all() as Array<{ name: string }>
	).map((r) => r.name);
	for (const column of [
		"requested_group",
		"requested_effort",
		"served_model",
		"served_provider",
		"served_provider_profile",
		"served_evidence",
	]) {
		if (!auditCols.includes(column))
			db.run(`ALTER TABLE route_audit ADD COLUMN ${column} TEXT`);
	}
	// W2256: wire-deny provenance — the canonical request path, whether
	// cross-dialect bridging was allowed, and the catalog provider pin.
	// A denial can strike before any selection exists, so these ride the
	// decision row itself (NULL = the row predates the column; safe
	// bounded strings, never raw URLs or credentials).
	for (const column of ["request_path", "provider_pin"]) {
		if (!auditCols.includes(column))
			db.run(`ALTER TABLE route_audit ADD COLUMN ${column} TEXT`);
	}
	if (!auditCols.includes("allow_cross"))
		db.run("ALTER TABLE route_audit ADD COLUMN allow_cross INTEGER");
	if (!auditCols.includes("settled_at"))
		db.run("ALTER TABLE route_audit ADD COLUMN settled_at INTEGER");
	if (!auditCols.includes("demand_observed"))
		db.run("ALTER TABLE route_audit ADD COLUMN demand_observed INTEGER");
	db.exec(
		"CREATE INDEX IF NOT EXISTS route_audit_settled ON route_audit(settled_at)",
	);
	if (!auditCols.includes("cache_r"))
		db.run("ALTER TABLE route_audit ADD COLUMN cache_r INTEGER");
	if (!auditCols.includes("cache_c"))
		db.run("ALTER TABLE route_audit ADD COLUMN cache_c INTEGER");
	if (!auditCols.includes("cache_reported"))
		db.run("ALTER TABLE route_audit ADD COLUMN cache_reported INTEGER");
	if (!auditCols.includes("cache_c_reported"))
		db.run("ALTER TABLE route_audit ADD COLUMN cache_c_reported INTEGER");
	// W706: hop marker (pre-W706 databases heal the same way; NULL hop =
	// unmarked legacy row — billable, the pre-W706 default).
	if (!auditCols.includes("hop"))
		db.run("ALTER TABLE route_audit ADD COLUMN hop TEXT");
	// W824: attempts + per-request token columns heal onto pre-W824 dbs
	// the same way — idempotent per open (pragma-checked), NULL = the
	// row predates the column (honest unknown, never zero-faked).
	if (!auditCols.includes("attempts"))
		db.run("ALTER TABLE route_audit ADD COLUMN attempts INTEGER");
	if (!auditCols.includes("in_tok"))
		db.run("ALTER TABLE route_audit ADD COLUMN in_tok INTEGER");
	if (!auditCols.includes("out_tok"))
		db.run("ALTER TABLE route_audit ADD COLUMN out_tok INTEGER");
	if (!auditCols.includes("trace_id"))
		db.run("ALTER TABLE route_audit ADD COLUMN trace_id TEXT");
	// W921: traffic kind (pre-W921 databases heal the same way; NULL =
	// the row predates the column — unmarked legacy).
	if (!auditCols.includes("traffic_kind"))
		db.run("ALTER TABLE route_audit ADD COLUMN traffic_kind TEXT");
	// W1106: body-free stream termination receipt — JSON {bytes_in,
	// chunks_in, last_chunk_ms, terminal}; NULL = the row predates the
	// column or the request never streamed.
	if (!auditCols.includes("stream_receipt"))
		db.run("ALTER TABLE route_audit ADD COLUMN stream_receipt TEXT");
	// W1265.1: account-policy provenance on the decision row (pre-W1265.1
	// databases heal the same way; NULL = the row predates the policy).
	if (!auditCols.includes("repo_hash"))
		db.run("ALTER TABLE route_audit ADD COLUMN repo_hash TEXT");
	if (!auditCols.includes("account_tier"))
		db.run("ALTER TABLE route_audit ADD COLUMN account_tier TEXT");
	if (!auditCols.includes("key_name"))
		db.run("ALTER TABLE route_audit ADD COLUMN key_name TEXT");
	// W1124.31: audited abandoned-receipt verdict — JSON {verdict:"abandoned",
	// at, actor, reason, age_ms, boot_origin}; NULL = never reconciled (the
	// receipt may still be live). A reconciled row keeps status/ok NULL:
	// no invented HTTP code, no retrospective provider blame.
	if (!auditCols.includes("reconciled"))
		db.run("ALTER TABLE route_audit ADD COLUMN reconciled TEXT");
	// W1132: cost columns heal onto pre-cost databases the same way —
	// NULL cost + '' version = the row predates pricing (honest unknown,
	// never zero-faked).
	if (!auditCols.includes("cost_usd"))
		db.run("ALTER TABLE route_audit ADD COLUMN cost_usd REAL");
	if (!auditCols.includes("rate_version"))
		db.run(
			"ALTER TABLE route_audit ADD COLUMN rate_version TEXT NOT NULL DEFAULT ''",
		);
	const usageCols = (
		db
			.query("SELECT name FROM pragma_table_info('router_usage')")
			.all() as Array<{ name: string }>
	).map((r) => r.name);
	if (!usageCols.includes("cost_usd"))
		db.run("ALTER TABLE router_usage ADD COLUMN cost_usd REAL");
	if (!usageCols.includes("rate_version"))
		db.run(
			"ALTER TABLE router_usage ADD COLUMN rate_version TEXT NOT NULL DEFAULT ''",
		);
	db.run(
		"CREATE INDEX IF NOT EXISTS route_audit_trace ON route_audit(trace_id, ts)",
	);
	const attemptCols = db
		.query("SELECT name FROM pragma_table_info('route_attempt')")
		.all()
		.map((row) => (row as { name: string }).name);
	if (!attemptCols.includes("upstream_refusal_code"))
		db.run("ALTER TABLE route_attempt ADD COLUMN upstream_refusal_code TEXT");
	if (!attemptCols.includes("refusal_origin"))
		db.run("ALTER TABLE route_attempt ADD COLUMN refusal_origin TEXT");
	if (!attemptCols.includes("provider_pool"))
		db.run("ALTER TABLE route_attempt ADD COLUMN provider_pool TEXT");
	if (!attemptCols.includes("queue_wait_ms"))
		db.run("ALTER TABLE route_attempt ADD COLUMN queue_wait_ms INTEGER");
	for (const column of ["provider_error_code", "provider_error_type"]) {
		if (!attemptCols.includes(column))
			db.run(`ALTER TABLE route_attempt ADD COLUMN ${column} TEXT`);
	}
	if (!attemptCols.includes("transport_json"))
		db.run("ALTER TABLE route_attempt ADD COLUMN transport_json TEXT");
	// W2191 (W1096 re-land): failure layer on attempt receipts (pre-land
	// databases heal the same way; NULL layer = the row predates it).
	if (!attemptCols.includes("layer"))
		db.run("ALTER TABLE route_attempt ADD COLUMN layer TEXT");
}
