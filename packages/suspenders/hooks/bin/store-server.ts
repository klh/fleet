// store-server.ts — W92 control-plane store server: governor.db as a loopback
// HTTP API. Local is the special case of distributed (owner doctrine): lanes
// on other machines bind via openStore() (GOVERNOR_STORE_URL / ${REG}/store.url)
// and hit these routes instead of the file; on the store host nothing changes.
//
// wire:  GET  /health    → { ok, store, user_version, identity_user_version }
//        POST /rpc       → { mode, sql, params } statement RPC (control plane)
//        POST /identity  → the same protocol against identity.db (W156)
//        /auth/*         issue / refresh / revoke / whoami (auth-server.ts)
// auth:  loopback bind only + optional shared token (GOVERNOR_STORE_TOKEN;
//        requests must then carry x-governor-token). Statement-shaped by
//        design: the port executes the exact SQL the CLIs run today, which is
//        what keeps CLI output byte-compatible. Requests serialize on ONE
//        connection so INSERT → last_insert_rowid() never interleaves.
//
// run:   bun hooks/bin/store-server.ts [--port 7794]
//        (port: --port > GOVERNOR_STORE_PORT > 7794; 7791 belt, 7795
//        knowledge-api, 7799 board — 7794 was free)

import { readFileSync, statSync } from "node:fs";
import { TransactionEvents } from "../lib/transaction-events.ts";
import { expireConsults } from "../lib/consult-expiry.ts";
import { consultStoreId } from "../lib/consult-outbox.ts";
import { storeAdmissionRefusal } from "../lib/store-admission.ts";
import {
	ensureConsultRelayReceipts,
	handleConsultRelay,
} from "../lib/consult-relay-receiver.ts";
import {
	ensureEventRelayReceipts,
	handleEventRelay,
} from "../lib/event-relay.ts";
import {
	type GovernorStore,
	type GovernorStatement,
	knowledgeSqlViolation,
	openGovernorDb,
} from "../lib/govdb.ts";
import { identitySqlViolation, openIdentityDb } from "../lib/identity-db.ts";
import {
	CAP_AUTH_ISSUANCE,
	hasCapability,
	readCapabilities,
} from "../lib/profile.ts";
import { servicemon } from "../lib/servicemon.ts";
import { classifySqlFailure } from "../lib/store-sql-error.ts";
import {
	beginWithHeal,
	sweepOrphanTxn,
	sweepStaleTxn,
	type TxCell,
} from "../lib/store-tx.ts";

const PORT =
	Number(process.argv[process.argv.indexOf("--port") + 1] ?? "") ||
	Number(process.env.GOVERNOR_STORE_PORT ?? 7794) ||
	7794;
function relayServerToken(): string {
	if (process.env.GOVERNOR_STORE_TOKEN) return process.env.GOVERNOR_STORE_TOKEN;
	const path = process.env.GOVERNOR_STORE_SERVER_TOKEN_FILE;
	if (!path) return "";
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o777) !== 0o600)
			return "";
		const value = readFileSync(path, "utf8").trim();
		return value && !/\s/.test(value) ? value : "";
	} catch {
		return "";
	}
}
const TOKEN = relayServerToken();
const RELAY_TOKEN = TOKEN;
const AUTH_CONFIGURED = !!(
	process.env.GOVERNOR_STORE_TOKEN ||
	process.env.GOVERNOR_STORE_SERVER_TOKEN_FILE
);

// W125 — shared /status + /metrics (lib/servicemon.ts). /health stays for
// compat. tokens_total is NOT served here: the store sees no token usage, and
// omitting the family honestly beats faking zeros.
const sm = servicemon({ service: "store-server", port: PORT });

// one connection for the whole server; /rpc requests serialize on it. A SECOND
// connection serves tagged transaction statements: WAL keeps outside reads
// flowing, outside writes wait on busy_timeout — a remote tx window is a few
// serialized round trips, well inside the 2s budget.
const db = openGovernorDb();
const INSTANCE_ID = consultStoreId(db);
ensureConsultRelayReceipts(db as unknown as GovernorStore);
ensureEventRelayReceipts(db as unknown as GovernorStore);
const txDb = openGovernorDb() as unknown as GovernorStore;
const TX_IDLE_MS = 10_000;

// W156 — the identity plane rides the SAME listener, served beside /rpc:
// POST /identity speaks the identical statement protocol against identity.db
// (openIdentity()'s HTTP binding), and /auth/* runs on the identity file too.
// Two plane connections + one tx connection each (WAL keeps outside reads
// flowing, outside writes wait on busy_timeout — a remote tx window is a few
// serialized round trips, well inside the 2s budget). /rpc execs against the
// governor pair, /identity + /auth/* against the identity pair.
const idb = openIdentityDb() as unknown as GovernorStore;
const txIdb = openIdentityDb() as unknown as GovernorStore;

// W978 — server-grade busy patience: openWALDb's 2s is tuned for CLI
// contention; the store host serves a whole fleet, so BEGIN IMMEDIATE waits
// out longer lock bursts here before the client's retry ladder (govdb-store
// W978: 3x 250ms) ever sees the failure. Must stay under the client's
// curl --max-time 10 so a busy-wait never reads as "unreachable".
const STORE_BUSY_TIMEOUT_MS = 5_000;
for (const c of [db, txDb, idb, txIdb])
	c.run(`PRAGMA busy_timeout=${STORE_BUSY_TIMEOUT_MS}`);

// one serialization chain PER PLANE — different SQLite files, so governor and
// identity statements need not serialize against each other; within a plane,
// INSERT → last_insert_rowid() must never interleave.
const perPlaneSerial = (): (<T>(fn: () => T) => Promise<T>) => {
	let chain: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => T): Promise<T> => {
		const p = chain.then(fn);
		chain = p.catch(() => {});
		return p;
	};
};
const serialGov = perPlaneSerial();
const serialIdb = perPlaneSerial();

// a plane's open-transaction cell — private to its route closure, typed by
// the tx module (W978: cells carry `started` for the stale sweep)
const govCell: TxCell = { v: null };
const idbCell: TxCell = { v: null };
const transactionEvents = new TransactionEvents((id) =>
	maybeBroadcastInsert("INSERT INTO events", id),
);

// W303 — WS push for coord subscribe: real-time replacement for the
// relaunch-a-long-poll pattern. Sockets are tracked here (not Bun pub/sub
// topics) because the per-socket filter mirrors cmdWait's exactly (target
// sid/null, scope-covers, kinds) and needs the same predicate, not a topic
// string match.
interface SubFilter {
	as: string;
	scope: string | null;
	kinds: string[];
	lastPong: number;
}
type Sock = Bun.ServerWebSocket<SubFilter>;
const sockets = new Set<Sock>();
const EVENTS_INSERT_RE = /^\s*INSERT\s+INTO\s+events\b/i;

// native control-frame ping/pong (not a JSON message — doesn't clutter the
// wire protocol or show up in message()). A dead/non-responsive peer (lost
// network, suspended laptop, killed process that never got a FIN) stops
// answering pongs; three missed intervals and the server reaps the socket
// itself instead of waiting on Bun's blunt 120s idleTimeout backstop.
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = PING_INTERVAL_MS * 3;
setInterval(() => {
	const now = Date.now();
	for (const ws of sockets) {
		if (now - ws.data.lastPong > PONG_TIMEOUT_MS) {
			sockets.delete(ws);
			try {
				ws.terminate();
			} catch {}
			continue;
		}
		try {
			ws.ping();
		} catch {}
	}
}, PING_INTERVAL_MS).unref();

// W611: consult deadlines need a clock — the hub sweeps OPEN consults past
// their deadline every 5 min; each flip emits consult.expired at the asker,
// which the W611 gate drain (lib/lane-inbox.ts) delivers into the lane's
// model context. .unref(): the sweep never holds the process open.
const CONSULT_SWEEP_MS = 5 * 60_000;
setInterval(() => {
	expireConsults(db);
}, CONSULT_SWEEP_MS).unref();

// W978 — the stale write-txn watchdog: every TXN_SWEEP_MS, abort tracked tx
// windows older than TXN_STALE_MS (total age, not idle) and probe both
// planes' main connections for untracked orphan write txns. store.txn-stale
// events ride the governor bus through maybeBroadcastInsert so WS
// subscribers see them live. The orphan probe is skipped while a window is
// open — it would only busy-wait against the window's own lock.
const TXN_SWEEP_MS = 5_000;
setInterval(() => {
	for (const plane of [
		{ label: "governor", cell: govCell, txConn: txDb, conn: db },
		{ label: "identity", cell: idbCell, txConn: txIdb, conn: idb },
	]) {
		const activeTransaction = plane.cell.v;
		const events = [
			sweepStaleTxn({
				label: plane.label,
				cell: plane.cell,
				txConn: plane.txConn,
			}),
			plane.cell.v
				? null
				: sweepOrphanTxn({ label: plane.label, conn: plane.conn }),
		];
		if (activeTransaction && !plane.cell.v)
			transactionEvents.finish(activeTransaction, false);
		for (const e of events) {
			if (!e) continue;
			const row = db.run(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'store-server', 'store.txn-stale', NULL, ?, NULL)",
				Date.now(),
				JSON.stringify(e),
			);
			maybeBroadcastInsert("INSERT INTO events", Number(row.lastInsertRowid));
			console.error(
				`[store] store.txn-stale ${e.plane}/${e.reason} age=${e.ageMs}ms`,
			);
		}
	}
}, TXN_SWEEP_MS).unref();

function scopeCoversLocal(a: string, b: string): boolean {
	return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

// Read only committed rows from the non-transaction connection. Transaction
// inserts reach this publisher after successful COMMIT, never before.
function maybeBroadcastInsert(sql: string, rowid: number): void {
	if (!EVENTS_INSERT_RE.test(sql) || !sockets.size) return;
	const row = db
		.query(
			"SELECT id, ts, source, kind, scope, payload, target FROM events WHERE id = ?",
		)
		.get(rowid) as
		| {
				id: number;
				ts: number;
				source: string;
				kind: string;
				scope: string | null;
				payload: string | null;
				target: string | null;
		  }
		| undefined;
	if (!row) return;
	for (const ws of sockets) {
		const f = ws.data;
		if (row.target !== null && row.target !== f.as) continue;
		if (f.scope && row.scope && !scopeCoversLocal(f.scope, row.scope)) continue;
		if (f.kinds.length && !f.kinds.includes(row.kind)) continue;
		ws.send(JSON.stringify(row));
	}
}

interface RpcBody {
	id?: string;
	mode?: string;
	sql?: string;
	params?: unknown[];
	txid?: string | null;
}

// one shape check for both transports: /rpc's 400 and the WS's {err} both
// bottom out here, so a statement that's good over HTTP is good over the
// socket and vice versa — no drift between the two wire paths.
function validateRpcBody(body: RpcBody): string | null {
	const modeOk = ["get", "all", "run", "tx"].includes(body.mode ?? "");
	if (!body.sql || !modeOk || !Array.isArray(body.params ?? []))
		return "bad request";
	// W166 — structural rejection: knowledge lives in knowledge.db; a
	// knowledge statement must ride the knowledge port (makeStore), never
	// the control-plane store (the design's W92 interaction). W156 — the
	// identity plane gets the same structural treatment: a statement over
	// the identity tables must ride /identity (openIdentity()), never /rpc.
	const kbHit = knowledgeSqlViolation(body.sql);
	if (kbHit)
		return `knowledge statements are rejected on the control-plane store ('${kbHit}' is not resident in governor.db) — bind the knowledge port (makeStore())`;
	const idHit = identitySqlViolation(body.sql);
	if (idHit)
		return `identity statements are rejected on the control-plane store ('${idHit}' is not resident in governor.db) — bind the identity port (openIdentity())`;
	return null;
}

const exec = (
	mode: "get" | "all" | "run",
	sql: string,
	params: unknown[],
	conn: GovernorStore,
	transaction: object | null = null,
): Record<string, unknown> => {
	// W1173 — a SQL failure is a typed refusal body, never a bare 500 or a raw
	// thrown string: one envelope on both transports (W716 admission-refusal
	// shape). W1173.1 — the executed evidence is PHASE-TRUTHFUL: a prepare-time
	// refusal proves the statement never stepped (executed:false); a run-time
	// failure does NOT (SQLite conflict clauses — UPDATE OR FAIL — keep the
	// failing statement's own pre-error row changes), so it reports
	// executed:"unknown" and never reads as a blind-retry invitation.
	let st: GovernorStatement;
	try {
		st = conn.query(sql);
	} catch (e) {
		const refusal = classifySqlFailure(e);
		if (!refusal) throw e;
		return { ...refusal, executed: false };
	}
	try {
		if (mode === "get") return { row: st.get(...params) ?? null };
		if (mode === "all") return { rows: st.all(...params) };
		const r = st.run(...params);
		const lastInsertRowid = Number(r.lastInsertRowid);
		if (EVENTS_INSERT_RE.test(sql))
			transactionEvents.inserted(transaction, lastInsertRowid);
		return { changes: r.changes, lastInsertRowid };
	} catch (e) {
		const refusal = classifySqlFailure(e);
		if (!refusal) throw e;
		return { ...refusal, executed: "unknown" };
	}
};

// plane-generic tx ops (W156): op rides the sql field — begin | commit |
// rollback. beginWithHeal (W662) covers the marker/conn desync on BOTH
// planes; per-plane cells keep tx windows private per file.
const rollIdle = (cell: TxCell, txConn: GovernorStore): void => {
	if (!cell.v || Date.now() - cell.v.last <= TX_IDLE_MS) return;
	const expired = cell.v;
	try {
		txConn.run("ROLLBACK");
	} catch {}
	cell.v = null;
	transactionEvents.finish(expired, false);
};

const beginOp = (
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Record<string, unknown> => {
	if (cell.v) return { err: "transaction already open" };
	// W662 — beginWithHeal probes the real connection state, kills an orphan
	// and re-begins; failures surface as {err}, never a 500.
	const began = beginWithHeal(txConn);
	if ("err" in began) return began;
	cell.v = { id: txid ?? "?", last: Date.now(), started: Date.now() };
	return { ok: true };
};

const endOp = (
	op: "commit" | "rollback",
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Record<string, unknown> => {
	if (!cell.v || cell.v.id !== (txid ?? "?"))
		return { err: "no such transaction" };
	const completed = cell.v;
	cell.v = null;
	try {
		txConn.run(op === "commit" ? "COMMIT" : "ROLLBACK");
	} catch (e) {
		try {
			txConn.run("ROLLBACK");
		} catch {}
		transactionEvents.finish(completed, false);
		return { err: `${op} failed: ${String(e)}` };
	}
	transactionEvents.finish(completed, op === "commit");
	return { ok: true };
};

const txOp = (
	op: string,
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Record<string, unknown> => {
	rollIdle(cell, txConn);
	if (op === "begin") return beginOp(txid, cell, txConn);
	if (op === "commit" || op === "rollback")
		return endOp(op, txid, cell, txConn);
	return { err: "no such tx op" };
};

// one statement-plane handler: guards → tx ops → serialized exec. /rpc and
// /identity ride this factory against their plane's connections (W156: one
// protocol, two files, byte-identical semantics with the old /rpc body).
const makePlaneRpc =
	(
		conn: GovernorStore,
		txConn: GovernorStore,
		serial: <T>(fn: () => T) => Promise<T>,
		_reject: (sql: string) => string | null,
		cell: TxCell,
	) =>
	async (body: RpcBody): Promise<Record<string, unknown>> => {
		if (body.mode === "tx")
			return serial(() =>
				txOp(body.sql ?? "", body.txid ?? null, cell, txConn),
			);
		const payload = {
			mode: body.mode as "get" | "all" | "run",
			sql: body.sql as string,
			params: body.params ?? [],
			txid: body.txid ?? null,
		};
		return serial(() => {
			rollIdle(cell, txConn);
			const t = cell.v;
			if (payload.txid && payload.txid !== t?.id)
				return { err: "no such transaction" };
			if (t) {
				// WAL lets outside reads use the plane's main connection while the
				// tagged writer owns txConn. Only outside writes must wait for the
				// transaction to end; blocking reads also breaks the HTTP client's
				// eager SELECT 1 probe under normal concurrent lane starts.
				if (!payload.txid && payload.mode === "run")
					return storeAdmissionRefusal();
				if (payload.txid && payload.txid !== t.id)
					return { err: "no such transaction" };
				if (payload.txid) t.last = Date.now();
			}
			return exec(
				payload.mode,
				payload.sql,
				payload.params,
				t && payload.txid ? txConn : conn,
				t && payload.txid ? t : null,
			);
		});
	};

// /rpc guard messages keep the W166 wire text byte-identical; identity gets
// the analogous one (same shape, its own port named).
const kbOnRpc = (hit: string): string =>
	`knowledge statements are rejected on the control-plane store ('${hit}' is not resident in governor.db) — bind the knowledge port (makeStore())`;
const idOnRpc = (hit: string): string =>
	`identity statements are rejected on the control-plane store ('${hit}' is not resident in governor.db) — bind the identity port (openIdentity())`;
const kbOnIdb = (hit: string): string =>
	`knowledge statements are rejected on the identity port ('${hit}' is not resident in identity.db) — bind the knowledge port (makeStore())`;

// the two planes: /rpc rejects knowledge AND identity statements (W166 +
// W156 wire text); /identity rejects knowledge only — it IS the identity port.
const rpcReject = (sql: string): string | null => {
	const kb = knowledgeSqlViolation(sql);
	if (kb) return kbOnRpc(kb);
	const id = identitySqlViolation(sql);
	return id ? idOnRpc(id) : null;
};
const idbReject = (sql: string): string | null => {
	const kb = knowledgeSqlViolation(sql);
	return kb ? kbOnIdb(kb) : null;
};

const rpcHandler = makePlaneRpc(
	db as unknown as GovernorStore,
	txDb,
	serialGov,
	rpcReject,
	govCell,
);
const idbHandler = makePlaneRpc(idb, txIdb, serialIdb, idbReject, idbCell);

// W156 — /rpc and the WS message() channel run the exact same validated
// statement through rpcHandler (the governor plane handler); the socket IS
// the control-plane binding — one wire contract, two transports, no drift.

// set right after Bun.serve() returns below; fetch closes over this instead
// of the (req, server) param, which servicemon's wrapped() fetch drops.
let server: ReturnType<typeof Bun.serve> | null = null;

const base = {
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/subscribe") {
			if (AUTH_CONFIGURED && !TOKEN)
				return new Response("Store authority unavailable", { status: 503 });
			if (TOKEN && url.searchParams.get("token") !== TOKEN)
				return new Response("forbidden", { status: 403 });
			const as = url.searchParams.get("as");
			if (!as || !server) return new Response("as required", { status: 400 });
			const data: SubFilter = {
				as,
				scope: url.searchParams.get("scope"),
				kinds: (url.searchParams.get("kinds") ?? "").split(",").filter(Boolean),
				lastPong: Date.now(),
			};
			return server.upgrade(req, { data })
				? undefined
				: new Response("upgrade failed", { status: 500 });
		}
		if (url.pathname === "/health") {
			const headers = {
				allow: "GET, HEAD, OPTIONS",
				"cache-control": "no-store",
			};
			if (req.method === "OPTIONS")
				return new Response(null, { status: 204, headers });
			if (req.method !== "GET" && req.method !== "HEAD")
				return new Response("method not allowed", { status: 405, headers });
			const result = {
				ok: true,
				store: "governor",
				instanceId: INSTANCE_ID,
				consultRelayReady: !!RELAY_TOKEN,
				user_version: (
					db.query("PRAGMA user_version").get() as { user_version: number }
				).user_version,
				identity_user_version: (
					idb.query("PRAGMA user_version").get() as { user_version: number }
				).user_version,
			};
			return req.method === "HEAD"
				? new Response(null, { headers })
				: Response.json(result, { headers });
		}
		// W149 — the identity surface rides this server (it owns governor.db):
		// /auth/token, /auth/refresh, /auth/revoke, /auth/whoami. Serialized on
		// the same connection chain as /rpc so issuance transactions never
		// interleave with CLI statements.
		// W165 — capability gate: a spoke profile ships no issuance module and
		// no issuance surface. The flag file decides; a spoke install answers
		// /auth/* with a bare 404 (a spoke never expects hub-only surfaces).
		// The auth-server module loads lazily so the same binary serves both
		// profiles (spoke installs exclude lib/auth-server.ts entirely).
		if (url.pathname.startsWith("/auth/")) {
			if (!hasCapability(readCapabilities(), CAP_AUTH_ISSUANCE))
				return new Response("not found", { status: 404 });
			const { handleAuthRoutes } = await import("../lib/auth-server.ts");
			// W156 — /auth/* serializes on the identity chain and execs on the
			// identity connection now (the token tables left governor.db).
			return serialIdb(() =>
				handleAuthRoutes(req, url, {
					store: idb,
				}),
			);
		}
		if (
			url.pathname === "/consult-relay" ||
			url.pathname.startsWith("/consult-relay/")
		) {
			if (!RELAY_TOKEN)
				return Response.json(
					{ error: "Consult receiver requires a configured server token" },
					{ status: 503 },
				);
			if (req.headers.get("x-governor-token") !== RELAY_TOKEN)
				return new Response("forbidden", { status: 403 });
			return serialGov(() => {
				rollIdle(govCell, txDb);
				if (govCell.v)
					return Response.json(
						{ error: "Store transaction is active" },
						{ status: 503 },
					);
				return handleConsultRelay(
					req,
					url,
					db as unknown as GovernorStore,
					(eventId) => maybeBroadcastInsert("INSERT INTO events", eventId),
				);
			});
		}
		// W1061 — cross-hub direct event relay: same gate shape, same serial
		// chain, same targeted WS notify as /consult-relay; the inserted event
		// rides the lane's own subscribe push (managed-runtime wake) and its
		// inbox/ack path stamps the SEEN/ACCEPTED receipts the status GET reads.
		if (
			url.pathname === "/event-relay" ||
			url.pathname.startsWith("/event-relay/")
		) {
			if (!RELAY_TOKEN)
				return Response.json(
					{ error: "Event relay requires a configured server token" },
					{ status: 503 },
				);
			if (req.headers.get("x-governor-token") !== RELAY_TOKEN)
				return new Response("forbidden", { status: 403 });
			return serialGov(() => {
				rollIdle(govCell, txDb);
				if (govCell.v)
					return Response.json(
						{ error: "Store transaction is active" },
						{ status: 503 },
					);
				return handleEventRelay(
					req,
					url,
					db as unknown as GovernorStore,
					(eventId) => maybeBroadcastInsert("INSERT INTO events", eventId),
				);
			});
		}
		// W156 — /identity: the identity plane's statement RPC. Same shape and
		// token gate as /rpc; the knowledge guard stays, the identity guard
		// does NOT (this IS the identity port — openIdentity() rides here).
		if (url.pathname === "/identity") {
			if (req.method !== "POST")
				return new Response("not found", { status: 404 });
			if (AUTH_CONFIGURED && !TOKEN)
				return new Response("Store authority unavailable", { status: 503 });
			if (TOKEN && req.headers.get("x-governor-token") !== TOKEN)
				return new Response("forbidden", { status: 403 });
			const idbBody = (await req.json()) as RpcBody;
			const idbModeOk = ["get", "all", "run", "tx"].includes(
				idbBody.mode ?? "",
			);
			if (!idbBody.sql || !idbModeOk || !Array.isArray(idbBody.params ?? []))
				return new Response("bad request", { status: 400 });
			const idbKbHit = knowledgeSqlViolation(idbBody.sql);
			if (idbKbHit) return Response.json({ err: kbOnIdb(idbKbHit) });
			return Response.json(await idbHandler(idbBody));
		}
		if (req.method !== "POST" || url.pathname !== "/rpc")
			return new Response("not found", { status: 404 });
		if (AUTH_CONFIGURED && !TOKEN)
			return new Response("Store authority unavailable", { status: 503 });
		if (TOKEN && req.headers.get("x-governor-token") !== TOKEN)
			return new Response("forbidden", { status: 403 });
		const body = (await req.json()) as RpcBody;
		const invalid = validateRpcBody(body);
		if (invalid === "bad request")
			return new Response("bad request", { status: 400 });
		if (invalid) return Response.json({ err: invalid });
		return Response.json(await rpcHandler(body));
	},
	websocket: {
		open(ws: Sock) {
			sockets.add(ws);
		},
		// W305 — bidirectional: a subscribed socket can also send the exact
		// {mode,sql,params} body /rpc accepts and get the correlated response
		// (echoing the caller's `id`) back over the still-open connection —
		// no second HTTP round trip from a process already holding a live
		// socket open. Malformed input gets an {err} reply, never a crash.
		async message(ws: Sock, raw: string | Buffer) {
			let body: RpcBody;
			try {
				body = JSON.parse(String(raw));
			} catch {
				ws.send(JSON.stringify({ err: "invalid JSON" }));
				return;
			}
			const invalid = validateRpcBody(body);
			if (invalid) {
				ws.send(JSON.stringify({ id: body.id, err: invalid }));
				return;
			}
			try {
				ws.send(JSON.stringify({ id: body.id, ...(await rpcHandler(body)) }));
			} catch (e) {
				ws.send(JSON.stringify({ id: body.id, err: String(e) }));
			}
		},
		pong(ws: Sock) {
			ws.data.lastPong = Date.now();
		},
		close(ws: Sock) {
			sockets.delete(ws);
		},
	},
};

// W125 — the observability wrap: /status + /metrics ride the SAME fetch via
// lib/servicemon.ts; the route body above stays untouched.
server = Bun.serve(sm.wrapped(base));

console.log(
	`governor store on 127.0.0.1:${PORT} (${TOKEN ? "token" : "open, loopback-only"})`,
);
