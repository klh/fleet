// w260-mcp-server.test.ts — W260: the belt MCP server surface. Covers the
// knowledge-store search port (temp stores, plain FTS5 rowid-join schema —
// the search SQL contract is the unit under test), the Entra bearer gate
// (RSA keypair + stub JWKS), and the Streamable HTTP e2e flow (subprocess
// server + in-process router stub).
import { describe, test, expect, setDefaultTimeout, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

// ─── fixture: temp knowledge stores ──────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "w260-mcp-"));
const KB_DB = join(dir, "knowledge.db");
const GOV_DB = join(dir, "governor.db");

const now = Date.now();
const card = {
	topic: "launchd plist wiring",
	fact: "launchctl kickstart gui/<uid>/<label> revives a launchd job",
	domain: "belt",
	area: "launchd",
	origin_kind: "lesson",
	source_ref: "packages/belt/docs/mcp.md",
	state: "active",
};
const card2 = {
	topic: "gate race protocol",
	fact: "content gate parse-checks Write/Edit payloads pre-write",
	domain: "suspenders",
	area: "gates",
	origin_kind: "lesson",
	source_ref: "packages/suspenders/docs/x.md",
	state: "candidate",
};

const db = new Database(KB_DB);
db.run("PRAGMA journal_mode=WAL");
db.run(
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, source_ref TEXT, state TEXT NOT NULL DEFAULT 'candidate', updated_at INTEGER)",
);
db.run(
	"CREATE VIRTUAL TABLE knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED)",
);
for (const c of [card, card2]) {
	const info =
		// standalone FTS5 (no external content): direct inserts, rowid-linked
		db.run(
			"INSERT INTO knowledge (ts, topic, fact, domain, area, origin_kind, source_ref, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				now,
				c.topic,
				c.fact,
				c.domain,
				c.area,
				c.origin_kind,
				c.source_ref,
				c.state,
				now,
			],
		).lastInsertRowid;
	db.run("INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (?, ?, ?)", [
		info,
		c.topic,
		c.fact,
	]);
}
db.close();

const gov = new Database(GOV_DB);
gov.run("PRAGMA journal_mode=WAL");
gov.run(
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
);
gov.run("CREATE VIRTUAL TABLE facts_fts USING fts5(value, key UNINDEXED)");
gov.run(
	"INSERT INTO facts (key, value, source, ts) VALUES ('lesson.sync-test', 'launchd jobs revive via launchctl kickstart; import paths differ between suspenders hooks/bin and .claude bin', 'test', ?)",
	[now],
);
gov.run(
	"INSERT INTO facts_fts (rowid, value, key) VALUES (1, 'launchd jobs revive via launchctl kickstart; import paths differ between suspenders hooks/bin and .claude bin', 'lesson.sync-test')",
);
gov.run(
	"CREATE TABLE consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, created_at INTEGER NOT NULL)",
);
gov.run("CREATE VIRTUAL TABLE consult_kb_fts USING fts5(problem)");
gov.run(
	"INSERT INTO consult_kb_fts (rowid, problem) VALUES (1, 'how to revive a launchd job')",
);
gov.run(
	"INSERT INTO consult_kb (id, problem, solution, project, created_at) VALUES (1, 'how to revive a launchd job', 'launchctl kickstart gui/<uid>/<label>', 'fleet', ?)",
	[now],
);
gov.close();

// ─── module under test (env must precede the import) ─────────────────────────
process.env.BELT_KNOWLEDGE_DB = KB_DB;
process.env.BELT_GOVERNOR_DB = GOV_DB;
const { searchKnowledge, ftsTerms } = await import("../bin/mcp-knowledge.ts");
const { _resetJwksCache, bearerOf, loadMcpAuthConfig, verifyEntraToken } =
	await import("../bin/mcp-auth.ts");

describe("w260 knowledge search", () => {
	test("ftsTerms: quoted OR-join, dedup, short-term drop", () => {
		expect(ftsTerms("Launchd wiring! a")).toBe('"launchd" OR "wiring"');
	});

	test("knowledge cards rank with trust markers", () => {
		const hits = searchKnowledge("launchd wiring");
		const card = hits.find((h) => h.kind === "knowledge");
		expect(card?.topic).toBe("launchd plist wiring");
		expect(card?.state).toBe("active");
		expect(card?.sourceRef).toContain("docs/mcp.md");
		expect(card?.ageDays).toBe(0);
	});

	test("stores group: knowledge, then facts, then consult_kb", () => {
		const hits = searchKnowledge("launchd");
		const kinds = hits.map((h) => h.kind);
		const k = kinds.indexOf("knowledge");
		const f = kinds.indexOf("fact");
		const c = kinds.indexOf("consult_kb");
		expect(k).toBe(0);
		expect(f).toBeGreaterThan(k);
		expect(c).toBeGreaterThan(f);
	});

	test("scoped search honestly excludes the untaggable stores", () => {
		const hits = searchKnowledge("launchd job", { domain: "belt" });
		expect(hits.every((h) => h.kind === "knowledge")).toBe(true);
		expect(hits.length).toBeGreaterThanOrEqual(1);
	});

	test("empty result is honest on no match", () => {
		expect(searchKnowledge("zzz-no-such-term")).toEqual([]);
	});
});

// ─── Entra bearer gate fixtures (RSA keypair + stub JWKS) ────────────────────
const JWKS_PORT = 19_770 + Math.floor(Math.random() * 200);
const keyPair = await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
);
const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
// WebCrypto exportKey omits kid — the JWKS lookup keys on it
pubJwk.kid = "test-key-1";
const jwksServer = Bun.serve({
	port: JWKS_PORT,
	fetch: () => Response.json({ keys: [pubJwk] }),
});

const makeToken = async (
	claims: Record<string, unknown>,
	kid = "test-key-1",
): Promise<string> => {
	const enc = (o: unknown) =>
		btoa(JSON.stringify(o))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
	const b64 = (buf: ArrayBuffer) =>
		btoa(String.fromCharCode(...new Uint8Array(buf)))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
	const signPart = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
	const sig = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		keyPair.privateKey,
		new TextEncoder().encode(signPart),
	);
	return `${signPart}.${b64(sig)}`;
};

const T0 = Math.floor(Date.now() / 1000);
const baseClaims = {
	iss: "https://login.microsoftonline.com/t1/v2.0",
	aud: "api://belt-mcp",
	sub: "u1",
	exp: T0 + 600,
	scp: "access_as_user",
};
const validToken = await makeToken(baseClaims);
const expiredToken = await makeToken({ ...baseClaims, exp: T0 - 3600 });
const wrongAudToken = await makeToken({ ...baseClaims, aud: "api://other" });
const unknownKidToken = await makeToken(baseClaims, "test-key-9");

const authCfg = {
	tenant: "t1",
	audience: "api://belt-mcp",
	requiredScope: null,
	issuer: "https://login.microsoftonline.com/t1/v2.0",
	jwksUri: `http://127.0.0.1:${JWKS_PORT}/keys`,
};

describe("w260 entra bearer gate", () => {
	test("bearerOf extracts the token", () => {
		expect(bearerOf("Bearer  abc.def.ghi ")).toBe("abc.def.ghi");
		expect(bearerOf("basic xyz")).toBe(null);
	});

	test("loadMcpAuthConfig requires tenant+audience", () => {
		const cfg = loadMcpAuthConfig({
			BELT_MCP_TENANT: "t1",
			BELT_MCP_AUDIENCE: "api://x",
		});
		expect(cfg?.tenant).toBe("t1");
		expect(loadMcpAuthConfig({})).toBe(null);
	});

	test("valid token verifies against the stub JWKS", async () => {
		_resetJwksCache();
		const v = await verifyEntraToken(validToken, authCfg);
		expect(v.ok).toBe(true);
	});

	test("expired / wrong-audience / unknown-kid fail honestly", async () => {
		_resetJwksCache();
		expect((await verifyEntraToken(expiredToken, authCfg)).reason).toContain(
			"expired",
		);
		expect((await verifyEntraToken(wrongAudToken, authCfg)).reason).toContain(
			"audience",
		);
		expect((await verifyEntraToken(unknownKidToken, authCfg)).reason).toContain(
			"kid",
		);
	});
});

// ─── Streamable HTTP e2e (subprocess server + in-process router stub) ────────
const MCP_PORT = 19_900 + Math.floor(Math.random() * 400);
const ROUTER_PORT = 19_500 + Math.floor(Math.random() * 300);
const routerStub = Bun.serve({
	port: ROUTER_PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/v1/messages") {
			const body = (await req.json()) as { messages?: { content?: string }[] };
			if (body.messages?.[0]?.content === "stall") await Bun.sleep(500);
			return Response.json({
				content: [{ type: "text", text: "stub-inference" }],
			});
		}
		return new Response("not found", { status: 404 });
	},
});

const spawnMcp = async (
	options: { port?: number; deadlineMs?: number } = {},
): Promise<{
	proc: ReturnType<typeof Bun.spawn>;
	url: string;
}> => {
	const port = options.port ?? MCP_PORT;
	const env = {
		...process.env,
		BELT_MCP_PORT: String(port),
		BELT_MCP_DEV: "1",
		BELT_KNOWLEDGE_DB: KB_DB,
		BELT_GOVERNOR_DB: GOV_DB,
		BELT_ROUTER_URL: `http://127.0.0.1:${ROUTER_PORT}`,
		...(options.deadlineMs
			? { BELT_MCP_REQUEST_MS: String(options.deadlineMs) }
			: {}),
	};
	const proc = Bun.spawn([process.execPath, "bin/mcp-server.ts"], {
		cwd: new URL("..", import.meta.url).pathname,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error("mcp-server did not come up");
		await Bun.sleep(150);
	}
	return { proc, url };
};

describe("w260 mcp e2e", () => {
	let proc: ReturnType<typeof Bun.spawn>;
	let url: string;
	let sid = "";

	const post = async (
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<Response> =>
		fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...(sid ? { "mcp-session-id": sid } : {}),
				...headers,
			},
			body: JSON.stringify(body),
		});

	test("boots in dev mode and answers /health", async () => {
		const spawned = await spawnMcp();
		proc = spawned.proc;
		url = spawned.url;
		const res = await fetch(`${url}/health`);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body.service).toBe("belt-mcp");
		expect(body.auth).toBe("dev-open");
	});

	test("initialize mints a session; tools/list lists both tools", async () => {
		const init = await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "t", version: "0" },
			},
		});
		expect(init.status).toBe(200);
		sid = init.headers.get("mcp-session-id") ?? "";
		expect(sid).not.toBe("");
		const body = (await init.json()) as {
			result: { protocolVersion: string; serverInfo: { name: string } };
		};
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(body.result.serverInfo.name).toBe("belt-mcp");
		const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const toolsBody = (await tools.json()) as {
			result: { tools: { name: string }[] };
		};
		const names = toolsBody.result.tools.map((t) => t.name);
		expect(names).toContain("knowledge_search");
		expect(names).toContain("belt_infer");
	});

	test("tools/call knowledge_search hits the temp store", async () => {
		const res = await post({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "knowledge_search",
				arguments: { query: "launchd wiring" },
			},
		});
		const body = (await res.json()) as {
			result: { content: { text: string }[]; isError: boolean };
		};
		expect(body.result.isError).toBe(false);
		const text = body.result.content[0]?.text ?? "";
		expect(text).toContain("[knowledge #1 · active");
		expect(text).toContain("ref: packages/belt/docs/mcp.md");
	});

	test("tools/call belt_infer rides the router stub", async () => {
		const res = await post({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "belt_infer",
				arguments: { prompt: "say hi", max_tokens: 16 },
			},
		});
		const body = (await res.json()) as {
			result: { content: { text: string }[]; isError: boolean };
		};
		expect(body.result.isError).toBe(false);
		expect(body.result.content[0]?.text).toBe("stub-inference");
	});

	test("unknown tool is a -32602 protocol error", async () => {
		const res = await post({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "no_such_tool", arguments: {} },
		});
		const body = (await res.json()) as {
			error: { code: number; message: string };
		};
		expect(body.error.code).toBe(-32602);
	});

	test("parse error answers 400; notification answers 202", async () => {
		const bad = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: "not-json",
		});
		expect(bad.status).toBe(400);
		const note = await post({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(note.status).toBe(202);
	});

	test("oversized JSON is rejected before parsing", async () => {
		const large = await post({
			jsonrpc: "2.0",
			id: 8,
			method: "ping",
			padding: "x".repeat(1_048_576),
		});
		expect(large.status).toBe(413);
	});

	test("app deadline terminates stalled inference", async () => {
		const short = await spawnMcp({ port: MCP_PORT + 1, deadlineMs: 80 });
		try {
			const started = Date.now();
			const response = await fetch(`${short.url}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 9,
					method: "tools/call",
					params: { name: "belt_infer", arguments: { prompt: "stall" } },
				}),
			});
			expect(response.status).toBe(504);
			expect(Date.now() - started).toBeLessThan(400);
		} finally {
			short.proc.kill();
		}
	});

	test("unknown session header → 404; forbidden host → 403; GET /mcp → 405", async () => {
		const stale = await post(
			{ jsonrpc: "2.0", id: 6, method: "ping" },
			{ "mcp-session-id": "bogus-session" },
		);
		expect(stale.status).toBe(404);
		const rebinding = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				host: "evil.example.com",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
		});
		expect(rebinding.status).toBe(403);
		const get = await fetch(`${url}/mcp`);
		expect(get.status).toBe(405);
	});

	afterAll(() => {
		proc?.kill();
		jwksServer.stop(true);
		routerStub.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});
});
