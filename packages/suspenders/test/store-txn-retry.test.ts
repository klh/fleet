// test/store-txn-retry.test.ts — W978: the 2026-10-20 store-lock incident.
// A second connection's write lock surfaced to mutating verbs as
// {err: "begin failed: ... database is locked"} with no recovery: the
// client's rpc ladder only retried reads, and the server had no watchdog
// for wedged write txns. Fault injection over the REAL topology: the
// production store-server child on a fixture HOME, a parent holder
// connection sitting on governor.db's write lock, and the client child
// (W362: async spawn) recovering through its retry ladder.
// Cheap exact-count ladder tests ride a refusal stub (W716 shape).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");

const home = mkdtempSync(join(tmpdir(), "suspenders-w978-txn-retry-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-w978-txn-retry-repo-"));

const servers: Bun.Server[] = [];
afterAll(() => {
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
const makeBeginStub = (refuse: (b: { mode: string; sql: string }) => boolean) => {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			if (new URL(req.url).pathname === "/probe") return Response.json({ ok: true });
			const body = (await req.json()) as {
				mode: string;
				sql: string;
				txid?: string;
			} & Record<string, unknown>;
			if (refuse(body)) {
				hits++;
				return Response.json({ err: "begin failed: SQLiteError: database is locked" });
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

const SERVER = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"store-server.ts",
);
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

describe("W978 — real write-lock fault injection (production topology)", () => {
	test(
		"client recovers a transaction when the lock clears inside the ladder",
		async () => {
			const port = await freePort();
			await startRealServer(port);
			const dbFile = join(
				home,
				".cache",
				"claude-governor",
				"governor.db",
			);
			const holding = holdLock(dbFile, 6500);
			const r = await runChild(
				txnChildCode(`http://127.0.0.1:${port}`),
				`http://127.0.0.1:${port}`,
			);
			expect(r.code).toBe(0);
			expect(parseOut(r.out, r.err)).toEqual({ out: 42 });
			await holding;
		},
		20_000,
	);
});

describe("W978 — begin retry ladder (refusal stub, exact counts)", () => {
	test("recovers after two locked refusals", async () => {
		let refused = 0;
		const stub = makeBeginStub(
			(b) => b.mode === "tx" && b.sql === "begin" && refused++ < 2,
		);
		const r = await runChild(
			beginChildCode(stub.url),
			stub.url,
		);
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
