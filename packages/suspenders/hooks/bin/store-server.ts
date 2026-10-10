// store-server.ts — W92 control-plane store server: governor.db as a loopback
// HTTP API. Local is the special case of distributed (owner doctrine): lanes
// on other machines bind via openStore() (GOVERNOR_STORE_URL / ${REG}/store.url)
// and hit these routes instead of the file; on the store host nothing changes.
//
// wire:  GET  /health  → { ok, store, user_version }
//        POST /rpc     → { mode: "get"|"all"|"run", sql, params }
//                        ← { row } | { rows } | { changes, lastInsertRowid }
// auth:  loopback bind only + optional shared token (GOVERNOR_STORE_TOKEN;
//        requests must then carry x-governor-token). Statement-shaped by
//        design: the port executes the exact SQL the CLIs run today, which is
//        what keeps CLI output byte-compatible. Requests serialize on ONE
//        connection so INSERT → last_insert_rowid() never interleaves.
//
// run:   bun hooks/bin/store-server.ts [--port 7794]
//        (port: --port > GOVERNOR_STORE_PORT > 7794; 7791 belt, 7795
//        knowledge-api, 7799 board — 7794 was free)
import {
	openGovernorDb,
	knowledgeSqlViolation,
	type GovernorStore,
} from "../lib/govdb.ts";
import { handleAuthRoutes } from "../lib/auth-server.ts";
import { servicemon } from "../lib/servicemon.ts";
import { readFileSync, statSync } from "node:fs";
import { consultStoreId } from "../lib/consult-outbox.ts";
import { expireConsults } from "../lib/consult-expiry.ts";
import {
	ensureConsultRelayReceipts,
	handleConsultRelay,
} from "../lib/consult-relay-receiver.ts";

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
const txDb = openGovernorDb() as unknown as GovernorStore;
let tx: { id: string; last: number } | null = null;
const TX_IDLE_MS = 10_000;

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

function scopeCoversLocal(a: string, b: string): boolean {
	return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

// best-effort: reads the just-inserted row back off the non-tx connection,
// so an insert made inside an open tx (not committed yet) is a silent no-op
// here rather than a premature broadcast of a row that might still roll back.
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

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => T): Promise<T> => {
	const p = chain.then(fn);
	chain = p.catch(() => {});
	return p;
};

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
	// the control-plane store (the design's W92 interaction).
	const kbHit = knowledgeSqlViolation(body.sql);
	if (kbHit)
		return `knowledge statements are rejected on the control-plane store ('${kbHit}' is not resident in governor.db) — bind the knowledge port (makeStore())`;
	return null;
}

const exec = (
	mode: "get" | "all" | "run",
	sql: string,
	params: unknown[],
	conn: GovernorStore,
): Record<string, unknown> => {
	const st = conn.query(sql);
	if (mode === "get") return { row: st.get(...params) ?? null };
	if (mode === "all") return { rows: st.all(...params) };
	const r = st.run(...params);
	const lastInsertRowid = Number(r.lastInsertRowid);
	maybeBroadcastInsert(sql, lastInsertRowid);
	return { changes: r.changes, lastInsertRowid };
};

// shared body: both /rpc and the WS message() channel run the exact same
// validated statement through it — one wire contract, two transports, no
// drift between what a lane can do over HTTP vs. over its open socket.
async function handleRpc(body: RpcBody): Promise<Record<string, unknown>> {
	if (body.mode === "tx") {
		// op rides the sql field: begin | commit | rollback
		const op = body.sql;
		return serial(() => {
			if (tx && Date.now() - tx.last > TX_IDLE_MS) {
				try {
					txDb.run("ROLLBACK");
				} catch {}
				tx = null;
			}
			if (op === "begin") {
				if (tx) return { err: "transaction already open" };
				txDb.run("BEGIN IMMEDIATE");
				tx = { id: body.txid ?? "?", last: Date.now() };
				return { ok: true };
			}
			if (!tx || tx.id !== (body.txid ?? "?"))
				return { err: "no such transaction" };
			tx = null;
			try {
				if (op === "commit") txDb.run("COMMIT");
				else txDb.run("ROLLBACK");
				return { ok: true };
			} catch (e) {
				try {
					txDb.run("ROLLBACK");
				} catch {}
				return { err: `${op} failed: ${String(e)}` };
			}
		});
	}
	const payload = {
		mode: body.mode as "get" | "all" | "run",
		sql: body.sql as string,
		params: body.params ?? [],
		txid: body.txid ?? null,
	};
	return serial(() => {
		if (tx && Date.now() - tx.last > TX_IDLE_MS) {
			try {
				txDb.run("ROLLBACK");
			} catch {}
			tx = null;
		}
		if (tx) {
			if (!payload.txid) return { err: "a transaction is open — retry" };
			if (payload.txid !== tx.id) return { err: "no such transaction" };
			tx.last = Date.now();
			return exec(payload.mode, payload.sql, payload.params, txDb);
		}
		return exec(
			payload.mode,
			payload.sql,
			payload.params,
			db as unknown as GovernorStore,
		);
	});
}

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
			};
			return req.method === "HEAD"
				? new Response(null, { headers })
				: Response.json(result, { headers });
		}
		// W149 — the identity surface rides this server (it owns governor.db):
		// /auth/token, /auth/refresh, /auth/revoke, /auth/whoami. Serialized on
		// the same connection chain as /rpc so issuance transactions never
		// interleave with CLI statements.
		if (url.pathname.startsWith("/auth/"))
			return serial(() =>
				handleAuthRoutes(req, url, {
					store: db as unknown as GovernorStore,
				}),
			);
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
			return serial(() => {
				if (tx && Date.now() - tx.last > TX_IDLE_MS) {
					try {
						txDb.run("ROLLBACK");
					} catch {}
					tx = null;
				}
				if (tx)
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
		return Response.json(await handleRpc(body));
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
				ws.send(JSON.stringify({ id: body.id, ...(await handleRpc(body)) }));
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
