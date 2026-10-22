// hooks/lib/govdb-store.ts — the W92 store port: consumers bind to
// GovernorStore, never to the DB file. The in-process SQLite Database
// and the HTTP binding (bin/store-server.ts) are the same interface.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { openGovernorDb } from "./govdb-open.ts";
import { REG } from "./govdb-util.ts";
import { openIdentityDb } from "./identity-db.ts";
import {
	StoreAdmissionError,
	isStoreAdmissionRefusal,
} from "./store-admission.ts";

// ─── W92 store port ──────────────────────────────────────────────────────────
// The control-plane seam: consumers bind to GovernorStore, never to the DB
// file. Local is the special case of distributed (owner doctrine): the DEFAULT
// binding is the in-process SQLite Database (today's behavior, byte-identical
// output) and the SAME interface rides HTTP (bin/store-server.ts, loopback)
// for lanes on other machines. Address chain: env GOVERNOR_STORE_URL →
// /store.url (coordinator-written one-liner) → in-process; the
// .local/mDNS legs land with cross-machine activation. Statement-shaped on
// purpose: a binding executes the exact SQL the CLIs run today — that is what
// keeps CLI output byte-compatible and makes the port a pure transport swap.
// Liveness sweeps (sweepStaleSessions) and token metrics (tokenUsage) read
// THIS host's ~/.claude/projects transcripts, so they stay Database-typed and
// sweep-taking verbs (coord bootstrap, coord gc) sweep only on db.local.
export interface StoreResult {
	changes: number;
	lastInsertRowid: number;
}

// the port's unit of exchange — bun:sqlite statements satisfy this structurally
export interface GovernorStatement {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): StoreResult;
}

export interface GovernorStore {
	// false on the HTTP binding: this process sees the local transcript tree,
	// so transcript-derived behavior (liveness sweeps) must not run remotely
	local: boolean;
	query(sql: string): GovernorStatement;
	run(sql: string, ...params: unknown[]): StoreResult;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

// W166 — the control-plane store must never proxy knowledge statements:
// knowledge is no longer resident in governor.db, so a knowledge statement
// riding the control plane either fails ("no such table") or — far worse —
// silently puts the read-heavy FTS workload back on the write-hot file if
// the tables are ever resurrected. String literals are stripped first:
// events LIKE 'knowledge.%' and deltas tbl='knowledge' are legit
// control-plane SQL over the WORD, never the table.
export function knowledgeSqlViolation(sql: string): string | null {
	const bare = sql
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""');
	const m = /\bknowledge(?:_fts|_queue)?\b/.exec(bare);
	return m ? m[0] : null;
}

// W716 — store-server's serialized-tx refusal: while a peer's transaction
// window is open, outside statements come back {err: "a transaction is
// open — retry"}. Read paths backoff-retry on it (rpc) instead of crashing.
const TX_BUSY_RE = /a transaction is open/i;

// W978 — the SQLite write-lock message rides the server's
// {err: "begin failed: SQLiteError: database is locked"} shape (store-tx
// beginWithHeal); the client's BEGIN IMMEDIATE retry keys on it.
const DB_LOCKED_RE = /database is locked/i;
const TX_ALREADY_OPEN_RE = /transaction already open/i;
// A tagged transaction can span several HTTP round trips. Concurrent CLI
// processes must wait for its owner to commit; retrying only SQLite's lock
// error misses the store server's own earlier admission refusal.
const TX_BEGIN_WAIT_MS = 35_000;

// HTTP binding: the same interface against bin/store-server.ts — sync by
// design (the CLIs are sync programs; one statement = one curl round trip).
// transaction(fn) holds a server-side BEGIN IMMEDIATE for the body's duration
// (client-tagged txid, serialized, idle-timeout rolled back), so work
// add/done/split and resume-session run unchanged on a remote lane.
export class HttpGovernorStore implements GovernorStore {
	readonly local = false;
	private txid: string | null = null;

	constructor(
		private base: string,
		private token: string | null,
		private path = "/rpc",
	) {
		// eager probe: a dead server fails AT OPEN — work.ts's mirror fallback
		// and coord's module-top open both expect today's throw timing
		this.query("SELECT 1").get();
	}

	// W716 — read paths backoff-retry the serialized-tx refusal (~3x/200ms):
	// work ready/dispatch crashed on it under concurrent lane load (the
	// server serializes /rpc on one connection; a peer's tx window blocks
	// outside statements for its whole duration). Reads are idempotent;
	// writes and tx control (begin/commit/rollback) surface immediately.
	private rpc(
		mode: "get" | "all" | "run" | "tx",
		sql: string,
		params: unknown[],
	): { row?: unknown; rows?: unknown[] } & Partial<StoreResult> {
		// W978 — begin joins the retry ladder: BEGIN IMMEDIATE against a
		// second connection's write lock ("database is locked") is a burst,
		// not a verdict — 3 attempts, 250ms backoff, then surface.
		const reads = mode === "get" || mode === "all";
		const isBegin = mode === "tx" && sql === "begin";
		const tries = reads || isBegin ? 3 : 1;
		const beginDeadline = isBegin ? Date.now() + TX_BEGIN_WAIT_MS : 0;
		const admissionDeadline = Date.now() + TX_BEGIN_WAIT_MS;
		for (let attempt = 1; ; attempt++) {
			try {
				return this.rpcOnce(mode, sql, params);
			} catch (e) {
				const msg = String(e);
				if (e instanceof StoreAdmissionError) {
					const remaining = admissionDeadline - Date.now();
					if (remaining <= 0) throw e;
					Bun.sleepSync(
						Math.min(remaining, 100 + Math.floor(Math.random() * 150)),
					);
					continue;
				}
				if (isBegin && TX_ALREADY_OPEN_RE.test(msg)) {
					const remaining = beginDeadline - Date.now();
					if (remaining <= 0) throw e;
					// Dephase many simultaneous lane starts without holding the server's
					// serialization chain, which must remain free for the owner COMMIT.
					Bun.sleepSync(
						Math.min(remaining, 100 + Math.floor(Math.random() * 150)),
					);
					continue;
				}
				const retryable = reads
					? TX_BUSY_RE.test(msg)
					: isBegin && DB_LOCKED_RE.test(msg);
				if (attempt >= tries || !retryable) throw e;
				Bun.sleepSync(reads ? 200 : 250);
			}
		}
	}

	private rpcOnce(
		mode: "get" | "all" | "run" | "tx",
		sql: string,
		params: unknown[],
	): { row?: unknown; rows?: unknown[] } & Partial<StoreResult> {
		const args = [
			"curl",
			"-sSf",
			"--max-time",
			"10",
			"-w",
			// W662 — trailing status line: curl -f flattens every HTTP >= 400
			// to exit 22, which the old error mislabeled as "unreachable"
			"\n%{http_code}",
			"-X",
			"POST",
			`${this.base}${this.path}`,
			"-H",
			"content-type: application/json",
		];
		if (this.token) args.push("-H", `x-governor-token: ${this.token}`);
		args.push(
			"--data-binary",
			JSON.stringify({ mode, sql, params, txid: this.txid }),
		);
		const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
		const raw = new TextDecoder().decode(r.stdout);
		const nl = raw.lastIndexOf("\n");
		const status = nl >= 0 ? Number(raw.slice(nl + 1).trim()) : NaN;
		const bodyText = nl >= 0 ? raw.slice(0, nl) : raw;
		if (r.exitCode !== 0) {
			if (status > 0) {
				const detail = bodyText.trim().slice(0, 200);
				throw new Error(
					`governor store ${this.base} HTTP ${status}${detail ? `: ${detail}` : ""}`,
				);
			}
			throw new Error(
				`governor store ${this.base} unreachable (curl exit ${r.exitCode})`,
			);
		}
		const out = JSON.parse(bodyText);
		// server-side refusals ride a 200 body ({err}) — curl -f cannot see them
		if (out.err) {
			if (isStoreAdmissionRefusal(out))
				throw new StoreAdmissionError(`governor store: ${out.err}`);
			throw new Error(`governor store: ${out.err}`);
		}
		return out;
	}

	query(sql: string): GovernorStatement {
		return {
			get: (...params) => this.rpc("get", sql, params).row,
			all: (...params) => this.rpc("all", sql, params).rows ?? [],
			run: (...params) =>
				this.rpc("run", sql, params) as unknown as StoreResult,
		};
	}

	run(sql: string, ...params: unknown[]): StoreResult {
		return this.rpc("run", sql, params) as unknown as StoreResult;
	}

	// bun:sqlite shape: transaction(fn) returns the callable that runs it. Over
	// HTTP the body's statements are TAGGED with a client txid; the server holds
	// BEGIN IMMEDIATE on its tx connection for the body's duration (serialized,
	// idle-timeout rolled back). A failed body rolls back before the throw.
	transaction<T>(fn: () => T): () => T {
		return () => {
			const id = crypto.randomUUID();
			this.txid = id; // begin CARRIES the txid — the server stamps it verbatim
			let finished = false;
			try {
				this.rpc("tx", "begin", []);
				const out = fn();
				this.rpc("tx", "commit", []);
				finished = true;
				return out;
			} finally {
				if (!finished) {
					try {
						this.rpc("tx", "rollback", []); // owner id still set
					} catch {}
				}
				this.txid = null;
			}
		};
	}

	close(): void {}
}

// binding resolver: GOVERNOR_STORE_URL wins, then /store.url, else the
// in-process SQLite Database. GOVERNOR_STORE_URL=local forces in-process
// (tests, emergencies). The cast is the ONE place Database becomes the port —
// bun's Database already has the statement shape, only the type differs.
export function openStore(): GovernorStore {
	const raw = (process.env.GOVERNOR_STORE_URL ?? storeUrlFile() ?? "").trim();
	if (raw && raw !== "local")
		return new HttpGovernorStore(raw.replace(/\/+$/, ""), resolveStoreToken());
	const d = openGovernorDb() as unknown as GovernorStore;
	d.local = true;
	return d;
}

// same binding chain as openStore(), exposed for callers that need the raw
// HTTP address (W303 — coord's WebSocket subscribe client upgrades this to
// ws(s):// itself). null when the binding is in-process SQLite (no server to
// connect a socket to).
export function resolveStoreHttpBase(): {
	base: string;
	token: string | null;
} | null {
	const raw = (process.env.GOVERNOR_STORE_URL ?? storeUrlFile() ?? "").trim();
	if (!raw || raw === "local") return null;
	return {
		base: raw.replace(/\/+$/, ""),
		token: resolveStoreToken(),
	};
}

// A launchd worker can use the same binding without embedding credentials in
// its plist. Private file configuration is shared with ordinary coord/work.
function resolveStoreToken(): string | null {
	if (process.env.GOVERNOR_STORE_TOKEN) return process.env.GOVERNOR_STORE_TOKEN;
	const file = process.env.GOVERNOR_STORE_TOKEN_FILE ?? `${REG()}/store.token`;
	if (!existsSync(file)) {
		if (process.env.GOVERNOR_STORE_TOKEN_FILE)
			throw new Error("Configured store token file unavailable");
		return null;
	}
	const stat = statSync(file);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
		throw new Error("Store token file must be private mode 600");
	const token = readFileSync(file, "utf8").trim();
	if (!token || /\s/.test(token)) throw new Error("Invalid store token file");
	return token;
}

function storeUrlFile(name = "store.url"): string | null {
	try {
		return readFileSync(`${REG()}/${name}`, "utf8") || null;
	} catch {
		return null;
	}
}

// W156 identity port — the store-port pattern on identity.db (federation doc:
// openIdentity(), served beside /rpc on :7794). Same resolver chain as
// openStore(): IDENTITY_STORE_URL → ${REG}/identity.url → in-process; the
// token header is the store server's ONE loopback token (GOVERNOR_STORE_TOKEN)
// since both planes ride the same listener. `local` = transcript-derived
// behavior exclusion, same meaning as GovernorStore.local.
export type IdentityStore = GovernorStore;

export function openIdentity(): IdentityStore {
	const raw = (
		process.env.IDENTITY_STORE_URL ??
		storeUrlFile("identity.url") ??
		""
	).trim();
	if (raw && raw !== "local")
		return new HttpGovernorStore(
			raw.replace(/\/+$/, ""),
			process.env.GOVERNOR_STORE_TOKEN ?? null,
			"/identity",
		);
	const d = openIdentityDb() as unknown as IdentityStore;
	d.local = true;
	return d;
}

// in-memory store for work.ts's mirror fallback — the port surface with zero
// file involvement (was a bare `new Database(":memory:")` in work.ts, which
// is a consumer and must not own a Database import)
export function openMemoryStore(): GovernorStore {
	const d = new Database(":memory:") as unknown as GovernorStore;
	d.local = true;
	return d;
}
