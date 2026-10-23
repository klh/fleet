// hooks/lib/store-sql-error.ts — W1173: typed store RPC SQL failures. The
// statement RPC used to surface a SQL failure as a bare 500 (HTTP) or a raw
// `String(e)` (WS); the W1118 re-close collision reached lanes as an opaque
// store error. One envelope, both transports, same shape discipline as the
// W716 admission refusal (store-admission.ts): a stable code, the deterministic
// message, and execution evidence.
//
// W1173.1 — the evidence is phase-truthful: `executed: false` only where
// non-execution is PROVEN (the prepare refused the statement — it never
// stepped). A run-time failure does NOT prove non-execution: SQLite conflict
// clauses keep a failing statement's own pre-error row changes (UPDATE OR
// FAIL persists the rows it already changed before the collision), so the
// envelope reports `executed: "unknown"` — truthful, and never an invitation
// to blind-retry a statement whose effects may already be persisted.
export const STORE_SQL_FAIL = "store_sql_fail";

/** Execution evidence for a refused statement. `false` = provably never
 * stepped (prepare-time refusal); `"unknown"` = the driver rejected a
 * stepping statement whose earlier effects may already be persisted. */
export type SqlExecutionEvidence = false | "unknown";

export interface StoreSqlRefusal {
	err: string;
	code: typeof STORE_SQL_FAIL;
	/** The driver's SQLITE_* class code, e.g. SQLITE_CONSTRAINT_PRIMARYKEY. */
	sqlite_code: string | null;
	/** Execution evidence — provably-not-executed or honestly unknown. */
	executed: SqlExecutionEvidence;
}

/** The typed error the HTTP client binding throws for a SQL-refusal body. */
export class StoreSqlError extends Error {
	constructor(
		message: string,
		readonly refusal: StoreSqlRefusal,
	) {
		super(message);
	}
}

export const storeSqlRefusal = (
	err: string,
	sqlite_code: string | null,
	executed: SqlExecutionEvidence,
): StoreSqlRefusal => ({
	err,
	code: STORE_SQL_FAIL,
	sqlite_code,
	executed,
});

/** bun:sqlite throws SQLiteError with a SQLITE_* .code; it is not exported as
 * a class on this Bun, so classification is structural. The conservative
 * default evidence is "unknown" — callers override to `false` only at a
 * PROVEN boundary (the prepare phase, which never steps the statement). */
export const classifySqlFailure = (e: unknown): StoreSqlRefusal | null => {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.startsWith("SQLITE_")
		? storeSqlRefusal(
				String((e as Error).message ?? "sql failure"),
				code,
				"unknown",
			)
		: null;
};

export const isStoreSqlRefusal = (body: { code?: unknown }): boolean =>
	body.code === STORE_SQL_FAIL;

/** W1173.1.1 — PROVEN table absence: both transports report "no such table"
 * on SQLITE_ERROR (the local driver throws it; the store RPC carries it in
 * the typed envelope's sqlite_code + err). Every other failure class —
 * SQLITE_BUSY, SQLITE_IOERR, transport refusals — is unknown/unavailable and
 * never reads as proof of absence. */
export const knownAbsentTable = (e: unknown, table: string): boolean => {
	const message = e instanceof Error ? e.message : String(e);
	const code =
		e instanceof StoreSqlError
			? e.refusal.sqlite_code
			: (classifySqlFailure(e)?.sqlite_code ?? null);
	return (
		code === "SQLITE_ERROR" &&
		new RegExp(`no such table: ${table}\\b`, "i").test(message)
	);
};
