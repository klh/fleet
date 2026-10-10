// test/fleet-mcp.test.ts — W607: the fleet MCP server for chat GUIs.
// Spawns the real server over stdio (async spawn — an in-process Bun.serve
// stub cannot answer during spawnSync) against a seeded scratch governor.db,
// plus the --http face, and drives the JSON-RPC: initialize → tools/list →
// tool calls. Auth = the buckle whoami plane, stubbed here: 200 + scope
// passes, 401 refuses with a readable why.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb.ts";

setDefaultTimeout(20_000);

const HERE = import.meta.dir;
const SERVER = join(HERE, "..", "hooks", "bin", "fleet-mcp.ts");
// the worktree root — the child canonicalizes it via projectIdentity, so
// seed rows must carry the canonical identity the work graph stores
const REPO = join(HERE, "..", "..", "..");
const PROJECT = projectIdentity(REPO);

interface StubVerdict {
	status: number;
	body: Record<string, unknown>;
}

function startWhoamiStub(verdicts: StubVerdict[]): {
	url: string;
	stop(): void;
} {
	let n = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			const v = verdicts[Math.min(n, verdicts.length - 1)];
			n++;
			return Response.json(v.body, { status: v.status });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

// seed a scratch HOME governor.db with the tables the read surfaces touch —
// the child's own openGovernorDb() migrates the rest (CREATE IF NOT EXISTS)
function seedDb(home: string): string {
	const reg = join(home, ".cache", "claude-governor");
	mkdirSync(reg, { recursive: true });
	const path = join(reg, "governor.db");
	const db = new Database(path);
	db.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, requires TEXT, tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on))",
	);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
	);
	db.run(
		"CREATE TABLE claims (sid TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT, hot INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, tp TEXT, PRIMARY KEY (sid, scope))",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	const now = Date.now();
	const ins = db.query(
		"INSERT INTO work_items (project, id, title, state, priority, owner_sid, created_at, updated_at, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	ins.run(PROJECT, "W900", "claimable one", "READY", 2, null, now, now, "seed");
	ins.run(
		PROJECT,
		"W901",
		"gated by open dep",
		"READY",
		1,
		null,
		now,
		now,
		null,
	);
	ins.run(PROJECT, "W899", "the open dep", "READY", 0, "sidA", now, now, null);
	db.query(
		"INSERT INTO work_deps (project, work_id, depends_on) VALUES (?, ?, ?)",
	).run(PROJECT, "W901", "W899");
	db.query(
		"INSERT INTO claims (sid, scope, intent, ts) VALUES (?, ?, ?, ?)",
	).run("autow607-test-lane", PROJECT, "W607 fleet MCP server", now);
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, ?, ?)",
	).run("lesson.w607-test", "the seeded lesson", "test", 3, now);
	db.close();
	return path;
}

interface Child {
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	call(body: Record<string, unknown>): Promise<Record<string, unknown>>;
	stop(): void;
}

function spawnServer(env: Record<string, string>, args: string[] = []): Child {
	const proc = Bun.spawn(["bun", SERVER, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: REPO,
		env: { ...process.env, ...env },
	});
	const pending = new Map<
		number,
		{ resolve: (v: Record<string, unknown>) => void }
	>();
	let buf = "";
	const reader = (async () => {
		for await (const chunk of proc.stdout) {
			buf += new TextDecoder().decode(chunk);
			for (;;) {
				const idx = buf.indexOf("\n");
				if (idx === -1) break;
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as {
					id?: number;
					result?: Record<string, unknown>;
				};
				if (typeof msg.id === "number") {
					const p = pending.get(msg.id);
					if (p) {
						pending.delete(msg.id);
						p.resolve(msg.result ?? {});
					}
				}
			}
		}
	})();
	let nextId = 1;
	return {
		proc,
		call: async (body) => {
			const id = nextId++;
			const req = { jsonrpc: "2.0", id, ...body };
			proc.stdin.write(`${JSON.stringify(req)}\n`);
			await proc.stdin.flush();
			return Promise.race([
				new Promise<Record<string, unknown>>((resolve) =>
					pending.set(id, { resolve }),
				),
				new Promise<Record<string, unknown>>((_, reject) =>
					setTimeout(() => reject(new Error("no reply in 15s")), 15_000),
				),
			]);
		},
		stop: () => {
			proc.stdin.end();
			proc.kill();
			void reader;
		},
	};
}

const childEnv = (home: string, stubUrl: string): Record<string, string> => ({
	HOME: home,
	FLEET_MCP_KEY: "bksk_testkey",
	SUSPENDERS_BUCKLE_FRONT: stubUrl,
	FLEET_MCP_PROJECT: REPO,
	FLEET_MCP_AUDIT: `${home}/audit.jsonl`,
});

describe("W607 fleet-mcp: stdio transport", () => {
	test("initialize + tools/list expose the six read surfaces", async () => {
		const home = `/tmp/w607-mcp-${Date.now()}`;
		seedDb(home);
		const stub = startWhoamiStub([
			{
				status: 200,
				body: {
					authenticated: true,
					key_id: "k123",
					scopes: ["buckle:proxy:READ_"],
				},
			},
		]);
		const c = spawnServer(childEnv(home, stub.url));
		try {
			const init = await c.call({
				method: "initialize",
				params: { protocolVersion: "2024-11-05" },
			});
			const info = init.serverInfo as { name: string };
			expect(info.name).toBe("fleet-mcp");
			const list = await c.call({ method: "tools/list" });
			const names = (list.tools as { name: string }[]).map((t) => t.name);
			expect(names).toEqual([
				"fleet_work_ready",
				"fleet_work_list",
				"fleet_work_show",
				"fleet_coord_fleet",
				"fleet_coord_fact",
				"fleet_coord_metrics",
			]);
		} finally {
			c.stop();
			stub.stop();
		}
	});

	test("fleet_work_ready returns only deps-met READY items (live db)", async () => {
		const home = `/tmp/w607-mcp-${Date.now()}`;
		seedDb(home);
		const stub = startWhoamiStub([
			{
				status: 200,
				body: {
					authenticated: true,
					key_id: "k123",
					scopes: ["buckle:proxy:READ_"],
				},
			},
		]);
		const c = spawnServer(childEnv(home, stub.url));
		try {
			const r = await c.call({
				method: "tools/call",
				params: {
					name: "fleet_work_ready",
					arguments: {},
				},
			});
			const out = (r.content as { text: string }[])[0]?.text ?? "";
			// W900 (no deps) + W899 (dep-less) are claimable; W901 gates on W899
			expect(out).toContain("READY (2)");
			expect(out).toContain("W900");
			expect(out).not.toContain("W901");
		} finally {
			c.stop();
			procWait(c);
			stub.stop();
		}
	});

	test("refused when buckle rejects the key (401 → isError result)", async () => {
		const home = `/tmp/w607-mcp-${Date.now()}`;
		seedDb(home);
		const stub = startWhoamiStub([
			{ status: 401, body: { code: "buckle.invalid_key" } },
		]);
		const c = spawnServer(childEnv(home, stub.url));
		try {
			const r = await c.call({
				method: "tools/call",
				params: { name: "fleet_coord_fleet", arguments: {} },
			});
			expect(r.isError).toBe(true);
			const out = (r.content as { text: string }[])[0]?.text ?? "";
			expect(out).toContain("fleet MCP refused");
			expect(out).toContain("401");
		} finally {
			c.stop();
			procWait(c);
			stub.stop();
		}
	});
});

function procWait(c: Child): void {
	void c.proc.exited;
}

describe("W607 fleet-mcp: facts + http face", () => {
	test("fleet_coord_fact get returns the seeded value", async () => {
		const home = `/tmp/w607-mcp-${Date.now()}`;
		seedDb(home);
		const stub = startWhoamiStub([
			{
				status: 200,
				body: {
					authenticated: true,
					key_id: "k123",
					scopes: ["buckle:proxy:READ_"],
				},
			},
		]);
		const c = spawnServer(childEnv(home, stub.url));
		try {
			const r = await c.call({
				method: "tools/call",
				params: {
					name: "fleet_coord_fact",
					arguments: { key: "lesson.w607-test" },
				},
			});
			const out = (r.content as { text: string }[])[0]?.text ?? "";
			expect(out).toContain("the seeded lesson");
			expect(out).toContain("v3");
		} finally {
			c.stop();
			procWait(c);
			stub.stop();
		}
	});

	test("--http face: initialize + tool call over POST /mcp", async () => {
		const home = `/tmp/w607-mcp-${Date.now()}`;
		seedDb(home);
		const stub = startWhoamiStub([
			{
				status: 200,
				body: {
					authenticated: true,
					key_id: "k123",
					scopes: ["buckle:proxy:READ_"],
				},
			},
		]);
		const port = 18000 + Math.floor(Math.random() * 2000);
		const proc = Bun.spawn(["bun", SERVER, "--http", String(port)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: REPO,
			env: { ...process.env, ...childEnv(home, stub.url) },
		});
		const proc2 = proc;
		try {
			// wait for the face to answer
			let up = false;
			for (let i = 0; i < 40 && !up; i++) {
				await new Promise((r) => setTimeout(r, 250));
				up = await fetch(`http://127.0.0.1:${port}/health`)
					.then((r) => r.ok)
					.catch(() => false);
			}
			expect(up).toBe(true);
			const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: {
					authorization: "Bearer bksk_testkey",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {},
				}),
			});
			expect(init.status).toBe(200);
			const initBody = (await init.json()) as {
				result?: { serverInfo?: { name?: string } };
			};
			expect(initBody.result?.serverInfo?.name).toBe("fleet-mcp");
			const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: {
					authorization: "Bearer bksk_testkey",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "fleet_work_ready", arguments: {} },
				}),
			});
			const callBody = (await call.json()) as {
				result?: { content?: { text?: string }[] };
			};
			const out = callBody.result?.content?.[0]?.text ?? "";
			expect(out).toContain("READY (2)");
			expect(out).toContain("W900");
			expect(out).not.toContain("W901");
		} finally {
			proc2.kill();
			stub.stop();
		}
	});
});
