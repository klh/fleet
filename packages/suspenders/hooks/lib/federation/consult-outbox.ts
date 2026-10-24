// W92.4 — port-shape param: callers hand either the store port (openStore(),
// HTTP or in-process) or the raw Database (store-server owner); both satisfy
// this structural statement shape, so the outbox rides any binding.
interface OutboxDb {
	query: (sql: string) => {
		get: (...p: unknown[]) => unknown;
		all: (...p: unknown[]) => unknown[];
		run: (...p: unknown[]) => unknown;
	};
	run: (sql: string, ...p: unknown[]) => unknown;
}

/** Local transaction boundary: a denial cannot commit a consult without its delivery. */
export function ensureConsultOutbox(db: OutboxDb): void {
	db.run(`CREATE TABLE IF NOT EXISTS consult_outbox (
		delivery_id TEXT PRIMARY KEY, local_consult_id INTEGER NOT NULL UNIQUE,
		destination TEXT, remote_project TEXT, remote_store_id TEXT, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
		remote_consult_id INTEGER, last_error TEXT)`);
	const columns = db.query("PRAGMA table_info(consult_outbox)").all() as {
		name: string;
	}[];
	if (!columns.some((column) => column.name === "remote_project"))
		db.run("ALTER TABLE consult_outbox ADD COLUMN remote_project TEXT");
	if (!columns.some((column) => column.name === "remote_store_id"))
		db.run("ALTER TABLE consult_outbox ADD COLUMN remote_store_id TEXT");
	db.run(
		"CREATE INDEX IF NOT EXISTS consult_outbox_ready ON consult_outbox(status,next_at)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS consult_outbox_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
	);
}

export function consultStoreId(db: OutboxDb): string {
	ensureConsultOutbox(db);
	db.query(
		"INSERT OR IGNORE INTO consult_outbox_meta(key,value) VALUES('store-id',?)",
	).run(crypto.randomUUID());
	return (
		db
			.query("SELECT value FROM consult_outbox_meta WHERE key='store-id'")
			.get() as { value: string }
	).value;
}

export function enqueueConsult(
	db: OutboxDb,
	consultId: number,
	now: number,
): string {
	const pending = db
		.query(
			"SELECT count(*) AS n FROM consult_outbox WHERE status IN ('PENDING','SENT')",
		)
		.get() as { n: number };
	if (pending.n >= 1000) throw new Error("Consult outbox capacity reached");
	const deliveryId = crypto.randomUUID();
	db.query(
		"INSERT INTO consult_outbox(delivery_id,local_consult_id,created_at,next_at) VALUES(?,?,?,?)",
	).run(deliveryId, consultId, now, now);
	return deliveryId;
}
