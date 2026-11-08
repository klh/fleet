// store.ts — W2869.2: the injected store facade every control-leaf module
// rides. Variadic params match bun:sqlite's native call shape so
// `sqliteStore` stays a thin, explicit adapter — no hand-cast at call
// sites, and tests inject a real :memory: database. The controller NEVER
// opens its own database file: the host (coord verb wiring, store-server
// adapter) injects one.
export interface RunnerStore {
	run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number };
	get<T>(sql: string, ...params: unknown[]): T | null;
	all<T>(sql: string, ...params: unknown[]): T[];
}

/** Structural minimum of a bun:sqlite Database — what sqliteStore wraps.
 *  Modern bun:sqlite keeps get/all on prepared STATEMENTS (Database.query),
 *  not on the Database itself. */
interface SqliteLike {
	run(sql: string, ...params: unknown[]): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
	query(sql: string): {
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
}

/** Adapt a bun:sqlite database to the facade. The two casts are the
 *  honest boundary: bun returns untyped rows and bigint rowids — both
 *  narrow here, once, at the edge. */
export const sqliteStore = (db: SqliteLike): RunnerStore => ({
	run: (sql, ...params) => {
		const res = db.run(sql, ...params);
		return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
	},
	get: <T>(sql: string, ...params: unknown[]): T | null =>
		(db.query(sql).get(...params) ?? null) as T | null,
	all: <T>(sql: string, ...params: unknown[]): T[] =>
		db.query(sql).all(...params) as T[],
});
