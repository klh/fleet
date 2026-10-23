// hooks/lib/store-sql-error.ts — W1173: typed store RPC SQL failures. The
// statement RPC used to surface a SQL failure as a bare 500 (HTTP) or a raw
// `String(e)` (WS); the W1118 re-close collision reached lanes as an opaque
// store error. One envelope, both transports, same shape discipline as the
// W716 admission refusal (store-admission.ts): a stable code, the deterministic
// message, and `executed: false` — a refused statement never proves execution.
export const STORE_SQL_FAIL = "store_sql_fail";

export interface StoreSqlRefusal {
	err: string;
	code: typeof STORE_SQL_FAIL;
	/** The driver's SQLITE_* class code, e.g. SQLITE_CONSTRAINT_PRIMARYKEY. */
	sqlite_code: string | null;
	/** A refused statement is not a statement that ran. */
	executed: false;
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
): StoreSqlRefusal => ({
	err,
	code: STORE_SQL_FAIL,
	sqlite_code,
	executed: false,
});

/** bun:sqlite throws SQLiteError with a SQLITE_* .code; it is not exported as
 * a class on this Bun, so classification is structural. */
export const classifySqlFailure = (e: unknown): StoreSqlRefusal | null => {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.startsWith("SQLITE_")
		? storeSqlRefusal(String((e as Error).message ?? "sql failure"), code)
		: null;
};

export const isStoreSqlRefusal = (body: { code?: unknown }): boolean =>
	body.code === STORE_SQL_FAIL;
