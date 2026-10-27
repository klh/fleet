// test/store-txn-retry.test.ts — W978: the 2026-10-20 store-lock incident.
// A second connection's write lock surfaced to mutating verbs as
// {err: "begin failed: ... database is locked"} with no recovery: the
// client's rpc ladder only retried reads, and the server had no watchdog
// for wedged write txns. Fault injection over the REAL topology: the
// production store-server child on a fixture HOME, a parent holder
// connection sitting on governor.db's write lock, and the client child
// (W362: async spawn) recovering through its retry ladder.
// Cheap exact-count ladder tests ride a refusal stub (W716 shape).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");

const home = mkdtempSync(join(tmpdir(), "suspenders-w978-txn-retry-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-w978-txn-retry-repo-"));

const servers: Bun.Server[] = [];
test.afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const runChild = async (
	code: string,
	url: string,
): Promise<{ code: number; out: string; err: string }> => {
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`${url}/probe`);
			break;
		} catch {}
		await Bun.sleep(20);
	}
	const p = Bun.spawn(["bun", "-e", code], {
		cwd: repo,
		env: {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
			GOVERNOR_STORE_URL: url,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	await p.exited;
	return {
		code: p.exitCode ?? 1,
		out: await new Response(p.stdout).text(),
		err: await new Response(p.stderr).text(),
	};
};

const parseOut = (out: string, err: string): unknown => {
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(
			`unparseable child stdout: ${JSON.stringify(out)} (stderr: ${JSON.stringify(err)})`,
		);
	}
};

// the refusal stub (W716 shape): refuses with the locked error whenever the
// predicate fires — tests pin exact attempt counts via hits().
const makeBeginStub = (
	refuse: (b: { mode: string; sql: string }) => boolean,
) => {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (new URL(req.url).pathname === "/probe")
				return Response.json({ ok: true });
			const body = (await req.json()) as {
				mode: string;
				sql: string;
				txid?: string;
			} & Record<string, unknown>;
			if (refuse(body)) {
				hits++;
				return Response.json({
					err: "begin failed: SQLiteError: database is locked",
				});
			}
			if (body.mode === "tx") return Response.json({ ok: true });
			if (body.mode === "get") return Response.json({ row: { one: 1 } });
			if (body.mode === "all") return Response.json({ rows: [] });
			return Response.json({ changes: 0, lastInsertRowid: 0 });
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, hits: () => hits };
};

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const SERVER = join(import.meta.dir, "..", "hooks", "bin", "store-server.ts");
const procs: ReturnType<typeof Bun.spawn>[] = [];

// the real store-server on a fixture HOME — the production topology the
// fault injection needs (client child → curl → server → governor.db), and
// the parent opens the db file the server child created.
const startRealServer = async (port: number): Promise<string> => {
	const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
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
		await Bun.sleep(100);
	}
	throw new Error("store server did not come up");
};

// parent-side holder: holds the governor.db write lock from a second
// connection for `ms`, then commits — the injected fault.
const holdLock = async (dbFile: string, ms: number): Promise<void> => {
	const { Database } = await import("bun:sqlite");
	const h = new Database(dbFile, { create: true });
	h.run("PRAGMA busy_timeout=2000");
	h.run("BEGIN IMMEDIATE");
	await Bun.sleep(ms);
	h.run("COMMIT");
	h.close();
};

const txnChildCode = (url: string): string => `
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const s = new HttpGovernorStore(${JSON.stringify(url)}, null);
const out = await s.transaction(() => 42)();
console.log(JSON.stringify({ out }));
`;

const beginChildCode = (url: string): string => `
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const s = new HttpGovernorStore(${JSON.stringify(url)}, null);
try {
	await s.transaction(() => 42)();
	console.log(JSON.stringify({ busy: false }));
} catch (e) {
	console.log(JSON.stringify({ busy: String(e).includes("database is locked") }));
}
`;

test.describe("W978 — real write-lock fault injection (production topology)", () => {
	test("client recovers a transaction when the lock clears inside the ladder", async () => {
		const port = await freePort();
		await startRealServer(port);
		const dbFile = join(home, ".cache", "claude-governor", "governor.db");
		const holding = holdLock(dbFile, 6500);
		const r = await runChild(
			txnChildCode(`http://127.0.0.1:${port}`),
			`http://127.0.0.1:${port}`,
		);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ out: 42 });
		await holding;
	}, 20_000);
});

test.describe("concurrent tagged transactions", () => {
	test("a second work client waits for the first transaction to commit", async () => {
		const port = await freePort();
		const url = await startRealServer(port);
		const first = crypto.randomUUID();
		const rpc = (sql: string) =>
			fetch(`${url}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "tx", sql, params: [], txid: first }),
			}).then((r) => r.json());
		expect(await rpc("begin")).toEqual({ ok: true });
		const read = await fetch(`${url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "get", sql: "SELECT 1 AS one", params: [] }),
		});
		expect(await read.json()).toEqual({ row: { one: 1 } });
		const outsideWrite = await fetch(`${url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "run",
				sql: "INSERT INTO events (ts, source, kind) VALUES (1, 'test', 'test')",
				params: [],
			}),
		});
		expect(await outsideWrite.json()).toEqual({
			err: "a transaction is open — retry",
			code: "store_tx_busy",
			executed: false,
		});
		const waiting = runChild(txnChildCode(url), url);
		await Bun.sleep(600);
		expect(await rpc("commit")).toEqual({ ok: true });
		const r = await waiting;
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ out: 42 });
	}, 15_000);
});

test("standalone writes wait outside owner transaction execution and commit exactly once on both planes", async () => {
	const url = await startRealServer(await freePort());
	for (const plane of ["/rpc", "/identity"]) {
		const txid = crypto.randomUUID();
		const rpc = (
			mode: string,
			sql: string,
			params: unknown[] = [],
			tag: string | null = null,
		) =>
			fetch(`${url}${plane}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode, sql, params, txid: tag }),
			}).then((response) => response.json());
		expect(
			await rpc(
				"run",
				"CREATE TABLE IF NOT EXISTS rpc_admission_probe(id TEXT PRIMARY KEY)",
			),
		).not.toHaveProperty("err");
		expect(await rpc("tx", "begin", [], txid)).toEqual({ ok: true });
		const waiting = Array.from({ length: 40 }, (_, i) =>
			runChild(
				`
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const store = new HttpGovernorStore(${JSON.stringify(url)}, null, ${JSON.stringify(plane)});
store.run("CREATE TABLE IF NOT EXISTS rpc_admission_probe(id TEXT PRIMARY KEY)");
store.query("INSERT INTO rpc_admission_probe(id) VALUES (?)").run(${JSON.stringify(plane)} + ${i});
console.log(JSON.stringify({ok:true}));
`,
				url,
			),
		);
		await Bun.sleep(900);
		expect(
			await rpc("get", "SELECT COUNT(*) AS n FROM rpc_admission_probe"),
		).toEqual({ row: { n: 0 } });
		expect(await rpc("tx", "commit", [], txid)).toEqual({ ok: true });
		const results = await Promise.all(waiting);
		for (const result of results)
			expect({
				code: result.code,
				out: parseOut(result.out, result.err),
			}).toEqual({ code: 0, out: { ok: true } });
		expect(
			await rpc("get", "SELECT COUNT(*) AS n FROM rpc_admission_probe"),
		).toEqual({ row: { n: 40 } });
		expect(
			await rpc(
				"run",
				"INSERT INTO rpc_admission_probe(id) VALUES ('escaped')",
				[],
				txid,
			),
		).toEqual({ err: "no such transaction" });
		expect(
			await rpc("get", "SELECT COUNT(*) AS n FROM rpc_admission_probe"),
		).toEqual({ row: { n: 40 } });
	}
}, 30_000);

test("an abandoned owner expires without replaying its tagged writes on the outside connection", async () => {
	const url = await startRealServer(await freePort());
	const txid = crypto.randomUUID();
	const rpc = (mode: string, sql: string, tag: string | null = null) =>
		fetch(`${url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode, sql, txid: tag }),
		}).then((response) => response.json());
	expect(await rpc("tx", "begin", txid)).toEqual({ ok: true });
	const waiting = runChild(
		`
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const store = new HttpGovernorStore(${JSON.stringify(url)}, null);
store.run("CREATE TABLE IF NOT EXISTS dead_owner_probe(id TEXT PRIMARY KEY)");
store.run("INSERT INTO dead_owner_probe(id) VALUES ('once')");
console.log(JSON.stringify({ok:true}));
`,
		url,
	);
	const result = await waiting;
	expect({ code: result.code, out: parseOut(result.out, result.err) }).toEqual({
		code: 0,
		out: { ok: true },
	});
	expect(
		await rpc(
			"run",
			"INSERT INTO dead_owner_probe(id) VALUES ('escaped')",
			txid,
		),
	).toEqual({ err: "no such transaction" });
	expect(
		await rpc("get", "SELECT COUNT(*) AS n FROM dead_owner_probe"),
	).toEqual({ row: { n: 1 } });
}, 20_000);

test("launch inventory reads do not issue DDL while a peer transaction is open", async () => {
	const url = await startRealServer(await freePort());
	const launch = join(
		import.meta.dir,
		"..",
		"scripts",
		"lib",
		"launch-fencing.ts",
	);
	const code = `
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const { launchIntent } = await import(${JSON.stringify(launch)});
const store = new HttpGovernorStore(${JSON.stringify(url)}, null);
console.log(JSON.stringify({intent:launchIntent(store,"fixture-project","W1")}));
`;
	expect((await runChild(code, url)).code).toBe(0);
	const txid = crypto.randomUUID();
	const rpc = (sql: string) =>
		fetch(`${url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "tx", sql, txid }),
		}).then((response) => response.json());
	expect(await rpc("begin")).toEqual({ ok: true });
	const result = await runChild(code, url);
	expect({ code: result.code, out: parseOut(result.out, result.err) }).toEqual({
		code: 0,
		out: { intent: null },
	});
	expect(await rpc("commit")).toEqual({ ok: true });
}, 15_000);

test("a failed commit clears the client transaction id after rollback", async () => {
	let outsideTxid: string | null | undefined;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === "/probe")
				return Response.json({ ok: true });
			const body = (await req.json()) as {
				mode: string;
				sql: string;
				txid: string | null;
			};
			if (body.sql === "SELECT 7 AS value") outsideTxid = body.txid;
			if (body.mode === "tx" && body.sql === "commit")
				return Response.json({ err: "commit failed: injected" });
			if (body.mode === "tx") return Response.json({ ok: true });
			return Response.json({ row: { one: 1 } });
		},
	});
	servers.push(server);
	const url = `http://127.0.0.1:${server.port}`;
	const r = await runChild(
		`
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const s = new HttpGovernorStore(${JSON.stringify(url)}, null);
try { s.transaction(() => 42)(); } catch {}
s.query("SELECT 7 AS value").get();
`,
		url,
	);
	expect(r.code).toBe(0);
	expect(outsideTxid).toBeNull();
});

test.describe("W978 — begin retry ladder (refusal stub, exact counts)", () => {
	test("recovers after two locked refusals", async () => {
		let refused = 0;
		const stub = makeBeginStub(
			(b) => b.mode === "tx" && b.sql === "begin" && refused++ < 2,
		);
		const r = await runChild(beginChildCode(stub.url), stub.url);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ busy: false });
		expect(stub.hits()).toBe(2);
	});

	test("surfaces after exactly three attempts", async () => {
		const stub = makeBeginStub((b) => b.mode === "tx" && b.sql === "begin");
		const r = await runChild(beginChildCode(stub.url), stub.url);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ busy: true });
		expect(stub.hits()).toBe(3);
	});

	test("run mode is not retried on the locked error", async () => {
		const stub = makeBeginStub((b) => b.mode === "run");
		const r = await runChild(
			`
const { HttpGovernorStore } = await import(${JSON.stringify(GOVDB)});
const s = new HttpGovernorStore(${JSON.stringify(stub.url)}, null);
try {
	s.run("INSERT INTO events(kind) VALUES ('w978t')");
	console.log(JSON.stringify({ busy: false }));
} catch (e) {
	console.log(JSON.stringify({ busy: String(e).includes("database is locked") }));
}
`,
			stub.url,
		);
		expect(r.code).toBe(0);
		expect(parseOut(r.out, r.err)).toEqual({ busy: true });
		expect(stub.hits()).toBe(1);
	});
});
