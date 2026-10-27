// test/store-sql-error.test.ts — W1173: typed store RPC SQL failures. The
// statement RPC used to surface a SQL failure as a bare 500 (HTTP) or a raw
// `String(e)` (WS); the W1118 re-close PK collision reached lanes as an
// opaque store error. Regression: the real store server returns a typed
// refusal envelope (stable code + sqlite_code + executed:false) with HTTP 200,
// the original row stands byte-identical, and the HTTP client binding throws
// the typed StoreSqlError.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	STORE_SQL_FAIL,
	classifySqlFailure,
	isStoreSqlRefusal,
	storeSqlRefusal,
} from "../hooks/lib/govdb/store-sql-error.ts";

// ── unit: the envelope shape and its guard ───────────────────────────────
describe("store sql refusal envelope", () => {
	test("classifySqlFailure types a real PK collision", () => {
		const { Database } = require("bun:sqlite");
		const db = new Database(":memory:");
		db.run("CREATE TABLE t (a TEXT PRIMARY KEY)");
		db.run("INSERT INTO t VALUES (?)", "x");
		try {
			db.run("INSERT INTO t VALUES (?)", "x");
			throw new Error("expected the PK collision to throw");
		} catch (e) {
			const refusal = classifySqlFailure(e);
			expect(refusal).toEqual({
				err: "UNIQUE constraint failed: t.a",
				code: STORE_SQL_FAIL,
				sqlite_code: "SQLITE_CONSTRAINT_PRIMARYKEY",
				executed: "unknown",
			});
		} finally {
			db.close();
		}
	});

	test("classifySqlFailure returns null for non-SQLite failures", () => {
		expect(classifySqlFailure(new Error("not sqlite"))).toBeNull();
		expect(classifySqlFailure(undefined)).toBeNull();
	});

	test("storeSqlRefusal + guard round-trip", () => {
		const refusal = storeSqlRefusal("boom", "SQLITE_ERROR");
		expect(isStoreSqlRefusal(refusal)).toBe(true);
		expect(isStoreSqlRefusal({ code: "store_tx_busy" })).toBe(false);
	});
});

// ── wire: the real store server types SQL failures on /rpc and /identity ────
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const SERVER = join(BIN, "store-server.ts");
const GOVDB_STORE = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"govdb",
	"govdb-store.ts",
);
const STORE_ERR_LIB = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"govdb",
	"store-sql-error.ts",
);
const home = mkdtempSync(join(tmpdir(), "suspenders-store-sql-err-home-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-store-sql-err-repo-"));
Bun.spawnSync(["git", "init", "-q", repo]);
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const startServer = async (
	port: number,
	env: Record<string, string> = {},
): Promise<string> => {
	const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};

const rpc = async (
	url: string,
	mode: string,
	sql: string,
	params: unknown[] = [],
): Promise<{ status: number; body: Record<string, unknown> }> => {
	const r = await fetch(`${url}/rpc`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode, sql, params }),
	});
	return {
		status: r.status,
		body: (await r.json()) as Record<string, unknown>,
	};
};

const childWire = { url: "" };
const runChild = (js: string): string => {
	const p = Bun.spawnSync(["bun", "-e", js], {
		cwd: repo,
		env: {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
			...(childWire.url ? { GOVERNOR_STORE_URL: childWire.url } : {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`child failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

// the W1118-shaped receipt row: same columns persistCompletion writes
const RECORD_INSERT = `INSERT INTO work_completion_records (project,item,summary,summary_hash,commit_sha,baseline_sha,completed_by,completed_at,capsule_json,evidence_json) VALUES ('p','W1118','${"x".repeat(40)}','h','0daf6a49000000000000',NULL,'lane-a',${Date.now()},'{}','{}')`;
const RECORD_TABLE = `CREATE TABLE IF NOT EXISTS work_completion_records (
 project TEXT NOT NULL, item TEXT NOT NULL, summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
 commit_sha TEXT NOT NULL, baseline_sha TEXT, completed_by TEXT NOT NULL,
 completed_at INTEGER NOT NULL, capsule_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
 PRIMARY KEY(project, item))`;

describe("store RPC types SQL failures (W1173)", () => {
	let url = "";
	beforeAll(async () => {
		url = await startServer(await freePort());
		childWire.url = url;
	});

	test("re-close PK collision rides a typed envelope, not a 500", async () => {
		const created = await rpc(url, "run", RECORD_TABLE);
		expect(created.status).toBe(200);
		expect(created.body.changes).toBe(0);
		const first = await rpc(url, "run", RECORD_INSERT);
		expect(first.status).toBe(200);
		expect(first.body.changes).toBe(1);
		const dup = await rpc(url, "run", RECORD_INSERT);
		// the collision must NOT be a bare 500 — it rides the typed envelope
		expect(dup.status).toBe(200);
		expect(dup.body.code).toBe(STORE_SQL_FAIL);
		expect(dup.body.sqlite_code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
		// W1173.1: an INSERT run-time collision cannot prove non-execution —
		// the conservative evidence is unknown, never a retry invitation.
		expect(dup.body.executed).toBe("unknown");
		expect(String(dup.body.err)).toContain(
			"UNIQUE constraint failed: work_completion_records.project",
		);
		// the original receipt row stands byte-identical after the refused insert
		const row = await rpc(
			url,
			"get",
			"SELECT summary, commit_sha, completed_by FROM work_completion_records WHERE item='W1118'",
		);
		expect(row.body.row).toEqual({
			summary: "x".repeat(40),
			commit_sha: "0daf6a49000000000000",
			completed_by: "lane-a",
		});
	});

	test("HTTP client binding throws the typed StoreSqlError", async () => {
		const out =
			runChild(`const { openStore } = await import(${JSON.stringify(GOVDB_STORE)});
const { StoreSqlError } = await import(${JSON.stringify(STORE_ERR_LIB)});
const s = openStore();
try {
	s.run("INSERT INTO work_completion_records (project,item,summary,summary_hash,commit_sha,baseline_sha,completed_by,completed_at,capsule_json,evidence_json) VALUES ('p','W1118','${"x".repeat(40)}','h','0daf6a49000000000000',NULL,'lane-a',${Date.now()},'{}','{}')");
	console.log("UNEXPECTED: duplicate insert succeeded");
} catch (e) {
	console.log(JSON.stringify({
		typed: e instanceof StoreSqlError,
		code: e.refusal?.code,
		sqlite: e.refusal?.sqlite_code,
		executed: e.refusal?.executed,
		msg: String(e.message).slice(0, 80),
	}));
}`);
		const r = JSON.parse(out);
		expect(r.typed).toBe(true);
		expect(r.code).toBe(STORE_SQL_FAIL);
		expect(r.sqlite).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
		expect(r.executed).toBe("unknown");
		expect(r.msg).toContain("governor store: UNIQUE constraint failed");
	});

	test("the /identity plane types SQL failures identically", async () => {
		const r = await fetch(`${url}/identity`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "get",
				sql: "SELECT * FROM missing_identity_table",
				params: [],
			}),
		});
		const body = (await r.json()) as Record<string, unknown>;
		expect(r.status).toBe(200);
		expect(body.code).toBe(STORE_SQL_FAIL);
		expect(body.sqlite_code).toBe("SQLITE_ERROR");
		expect(body.executed).toBe(false);
	});
});

// ── W1173.1 B1: run-time SQL failures can carry partial statement effects ───
// SQLite conflict clauses (UPDATE OR FAIL keeps the failing statement's own
// pre-error row changes) mean a refused statement is NOT always a statement
// with no effects — the envelope must never claim provable non-execution.
describe("partial statement effects (W1173.1 B1)", () => {
	let url = "";
	beforeAll(async () => {
		url = await startServer(await freePort());
		childWire.url = url;
	});

	test("UPDATE OR FAIL reports unknown execution, partial effect persists", async () => {
		// the B1 shape: unique rows 1,2,3; one UPDATE sets row 1 to 10, then
		// row 2 collides — OR FAIL preserves the statement's own row change.
		await rpc(
			url,
			"run",
			"CREATE TABLE w1173_partial (id INTEGER PRIMARY KEY, v INTEGER UNIQUE)",
		);
		for (const v of [1, 2, 3])
			await rpc(url, "run", "INSERT INTO w1173_partial (v) VALUES (?)", [v]);
		const fail = await rpc(
			url,
			"run",
			"UPDATE OR FAIL w1173_partial SET v = 10",
		);
		expect(fail.status).toBe(200);
		expect(fail.body.code).toBe(STORE_SQL_FAIL);
		expect(fail.body.sqlite_code).toBe("SQLITE_CONSTRAINT_UNIQUE");
		// B1: non-execution is NOT provable here — the SELECT below proves the
		// statement's own pre-error row change persisted.
		expect(fail.body.executed).toBe("unknown");
		const after = await rpc(
			url,
			"all",
			"SELECT id, v FROM w1173_partial ORDER BY id",
		);
		expect(after.body.rows).toEqual([
			{ id: 1, v: 10 },
			{ id: 2, v: 2 },
			{ id: 3, v: 3 },
		]);
	});

	test("prepare-time refusal keeps provable executed:false on /rpc", async () => {
		// a statement the PREPARE rejects never stepped — non-execution is
		// provable there, and the evidence stays the strong false.
		const r = await rpc(url, "get", "SELECT * FROM w1173_missing_table");
		expect(r.status).toBe(200);
		expect(r.body.code).toBe(STORE_SQL_FAIL);
		expect(r.body.sqlite_code).toBe("SQLITE_ERROR");
		expect(r.body.executed).toBe(false);
	});

	test("client binding does not blind-retry a SQL refusal", async () => {
		// every HTTP round trip rides one curl spawnSync; the counter proves the
		// write refusal surfaced after exactly ONE attempt — the client retry
		// ladder reads BUSY/tx-open, never store_sql_fail.
		const out = runChild(`const realSpawnSync = Bun.spawnSync;
let curlCalls = 0;
Bun.spawnSync = ((...a) => { curlCalls++; return realSpawnSync(...a); });
const { openStore } = await import(${JSON.stringify(GOVDB_STORE)});
const { StoreSqlError } = await import(${JSON.stringify(STORE_ERR_LIB)});
const s = openStore();
const before = curlCalls;
try {
	s.run("UPDATE OR FAIL w1173_partial SET v = 10");
	console.log(JSON.stringify({ outcome: "unexpected-success" }));
} catch (e) {
	console.log(JSON.stringify({
		typed: e instanceof StoreSqlError,
		executed: e.refusal?.executed,
		delta: curlCalls - before,
	}));
}`);
		const r = JSON.parse(out);
		expect(r.typed).toBe(true);
		expect(r.executed).toBe("unknown");
		expect(r.delta).toBe(1);
	});
});
