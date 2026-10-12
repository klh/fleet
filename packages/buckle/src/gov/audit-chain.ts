// src/gov/audit-chain.ts — W703: tamper-evident append-only auth_events.
// Every row carries prev_hash (the previous row's row_hash; GENESIS for the
// first) and row_hash = sha256(prev_hash \n canonical-json(row)). Editing a
// row breaks its own hash; removing or reordering one breaks the next row's
// prev_hash link. Evidence, not prevention: a DB-level writer can rewrite the
// whole tail, so `expectHead` lets an operator pin the head hash out-of-band
// (a deleted TAIL is invisible without it). Retention-compatible (W174
// archive-before-delete): a pruned PREFIX re-anchors at the first surviving
// row, reported as `anchored` — only interior breaks are failures.
import type { Database } from "bun:sqlite";

export const GENESIS = "0".repeat(64);

export interface AuthEventRow {
	id: number;
	ts: number;
	actor: string | null;
	event: string;
	jti: string | null;
	via: string | null;
	prev_hash: string | null;
	row_hash: string | null;
}

function chainHash(prev: string, r: AuthEventRow): string {
	const body = JSON.stringify([r.id, r.ts, r.actor, r.event, r.jti, r.via]);
	return new Bun.CryptoHasher("sha256")
		.update(`${prev}\n${body}`)
		.digest("hex");
}

/** Guarded ALTERs (house idempotent pattern): pre-chain databases heal. */
export function ensureChainColumns(db: Database): void {
	const cols = (
		db
			.query("SELECT name FROM pragma_table_info('auth_events')")
			.all() as Array<{ name: string }>
	).map((c) => c.name);
	if (!cols.includes("prev_hash"))
		db.run("ALTER TABLE auth_events ADD COLUMN prev_hash TEXT");
	if (!cols.includes("row_hash"))
		db.run("ALTER TABLE auth_events ADD COLUMN row_hash TEXT");
}

/** Append one chained row. IMMEDIATE transaction: the head read and the
 *  insert are one writer turn, so concurrent replicas cannot fork the chain. */
export function appendAuthEvent(
	db: Database,
	e: Pick<AuthEventRow, "ts" | "actor" | "event" | "jti" | "via">,
): void {
	db.transaction(() => {
		const head = db
			.query("SELECT id, row_hash FROM auth_events ORDER BY id DESC LIMIT 1")
			.get() as { id: number; row_hash: string | null } | null;
		const prev = head?.row_hash ?? GENESIS;
		const row: AuthEventRow = {
			id: (head?.id ?? 0) + 1,
			...e,
			prev_hash: prev,
			row_hash: null,
		};
		row.row_hash = chainHash(prev, row);
		db.query(
			"INSERT INTO auth_events (id, ts, actor, event, jti, via, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			row.id,
			row.ts,
			row.actor,
			row.event,
			row.jti,
			row.via,
			row.prev_hash,
			row.row_hash,
		);
	}).immediate();
}

export interface ChainVerdict {
	ok: boolean;
	/** rows walked (legacy included) */
	rows: number;
	/** leading pre-chain rows (NULL hashes) — unprotected, counted */
	legacy: number;
	/** row_hash of the last chained row (pin it out-of-band for tail checks) */
	head: string | null;
	/** true when the first chained row's prev_hash is not GENESIS (pruned prefix) */
	anchored: boolean;
	broken?: { id: number; reason: string };
}

/** Stream the table in id order (bounded memory) and check every link. */
export function verifyAuthChain(
	db: Database,
	opts: { expectHead?: string } = {},
): ChainVerdict {
	const v: ChainVerdict = {
		ok: true,
		rows: 0,
		legacy: 0,
		head: null,
		anchored: false,
	};
	const fail = (id: number, reason: string): ChainVerdict => ({
		...v,
		ok: false,
		broken: { id, reason },
	});
	let prev: string | null = null;
	for (const r of db
		.query("SELECT * FROM auth_events ORDER BY id")
		.iterate() as Iterable<AuthEventRow>) {
		v.rows++;
		if (r.row_hash === null || r.prev_hash === null) {
			if (prev !== null) return fail(r.id, "hash stripped after chain start");
			v.legacy++;
			continue;
		}
		if (prev === null) {
			v.anchored = r.prev_hash !== GENESIS;
		} else if (r.prev_hash !== prev) {
			return fail(r.id, "prev_hash link broken (row removed or reordered)");
		}
		if (chainHash(r.prev_hash, r) !== r.row_hash)
			return fail(r.id, "row_hash mismatch (row edited)");
		prev = v.head = r.row_hash;
	}
	if (opts.expectHead !== undefined && opts.expectHead !== v.head)
		return fail(0, "head mismatch (tail removed or chain rewritten)");
	return v;
}
