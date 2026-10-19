// fleet/confidence.ts — W950 addendum (owner WS #47631): STAMP AT INGEST.
//
// Every row-set the ingest pipeline writes carries its confidence stamp
// natively, written in the SAME transaction as the rows it grades — not a
// post-pass. Unit = the ingest transaction (one session derivation): all rows
// of one transcript share one source tier, so the session-level stamp grades
// the whole derivation; consumers resolve a row's confidence through its
// session join.
//
// Mechanism: a fleet-owned AFTER INSERT trigger on upstream's `session`
// table. Upstream ingest.ts is over the fleet 1500-line cap and stays
// byte-pure (rebase-friendliness), so the stamp rides SQLite itself: the
// trigger fires inside writeSession's existing transaction. Insert-only:
// re-derivations keep the ORIGINAL stamp (it grades the source derivation);
// verdict transitions (stale/superseded/...) are the W953/W955 module's job
// and append via the same table.
//
// Stamp shape = the W953/W955 schema: {value, setter, verdict, ts, evidence,
// prior}, append-only history (INSERT only, never overwrite), self-upgrades
// structurally absent here (ingest only ever writes the mechanical floor).
import type { Database } from "bun:sqlite";

/** The mechanical ingest floor per owner doctrine: raw parse, no review. */
export const INGEST_STAMP = {
  value: 0.4,
  setter: "mechanical:decant",
  verdict: "fresh",
} as const;

/** Fleet-owned confidence history (outside upstream schema files). */
const CONFIDENCE_DDL = `
CREATE TABLE IF NOT EXISTS confidence_stamp (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	entity TEXT NOT NULL,
	entity_id INTEGER NOT NULL,
	value REAL NOT NULL,
	setter TEXT NOT NULL,
	verdict TEXT NOT NULL,
	ref TEXT,
	evidence TEXT,
	prior REAL,
	ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS confidence_stamp_entity_idx
	ON confidence_stamp(entity, entity_id, id);
CREATE TRIGGER IF NOT EXISTS confidence_stamp_session_insert
AFTER INSERT ON session
BEGIN
	INSERT INTO confidence_stamp
		(entity, entity_id, value, setter, verdict, evidence, prior, ts)
	VALUES (
		'session', NEW.id, ${INGEST_STAMP.value}, '${INGEST_STAMP.setter}',
		'${INGEST_STAMP.verdict}', 'ingest:' || NEW.tool, NULL,
		unixepoch() * 1000
	);
END;
`;

const ensured = new WeakSet<object>();

/** Idempotent, once per database handle. DDL inside the ingest tx is safe
 * (SQLite allows it; the table is a fleet-owned addition to the archive). */
export function ensureConfidenceTable(db: Database): void {
  if (ensured.has(db)) return;
  db.exec(CONFIDENCE_DDL);
  ensured.add(db);
}

/** The verdict enum per W953/W955; superseded|contradicted need a ref. */
export function validateStamp(stamp: { verdict: string; ref?: string | null }): string | null {
  const valid = new Set(["fresh", "stale", "superseded", "contradicted", "confirmed", "retracted"]);
  if (!valid.has(stamp.verdict)) return `bad verdict '${stamp.verdict}'`;
  if (
    (stamp.verdict === "superseded" || stamp.verdict === "contradicted") &&
    (stamp.ref == null || stamp.ref === "")
  ) {
    return `verdict '${stamp.verdict}' requires ref`;
  }
  return null;
}

/** Latest stamp for an entity, or null. */
export function latestStamp(
  db: Database,
  entity: string,
  entityId: number,
): {
  value: number;
  setter: string;
  verdict: string;
  ref: string | null;
  evidence: string | null;
  prior: number | null;
  ts: number;
} | null {
  return (
    (db
      .query(
        `SELECT value, setter, verdict, ref, evidence, prior, ts
				   FROM confidence_stamp
				  WHERE entity = ? AND entity_id = ?
				  ORDER BY id DESC LIMIT 1`,
      )
      .get(entity, entityId) as {
      value: number;
      setter: string;
      verdict: string;
      ref: string | null;
      evidence: string | null;
      prior: number | null;
      ts: number;
    } | null) ?? null
  );
}
