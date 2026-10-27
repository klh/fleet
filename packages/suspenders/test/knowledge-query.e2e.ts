// knowledge-query.test.ts — W1218: the knowledge query faces' guard core.
// Lib level: the read-only lint (write shapes, multi-statement, table
// allowlist, LIMIT enforcement), the ro executor, the buckle verify client,
// and the NL translator (fence extraction + the SAME lint). API level: the
// real bin spawned with a stub buckle verify front + stub SQL LLM — auth
// matrix, refusal statuses, and the acceptance window (rows + sql + <2s).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	answerKnowledgeQuestion,
	executeKnowledgeSql,
	knowledgeQueryConf,
	KNOWLEDGE_LIMIT_MAX,
	KNOWLEDGE_QUERY_SCOPE,
	KNOWLEDGE_READ_SCOPE,
	lintReadOnlySql,
	translateQuestion,
	verifyKnowledgeKey,
} from "../hooks/lib/knowledge/knowledge-query.ts";
import { unusedPort } from "./helpers/board-fixture.ts";

// ─── lib-level fixtures ─────────────────────────────────────────────────────
const mem = new Database(":memory:");
mem.run(
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY, ts INTEGER, topic TEXT, fact TEXT, confidence REAL, state TEXT)",
);
mem.run(
	"CREATE TABLE knowledge_claims (id INTEGER PRIMARY KEY, evidence_id TEXT, claim TEXT, scope TEXT)",
);
mem.run("CREATE VIRTUAL TABLE knowledge_fts USING fts5(topic, fact)");
mem.run(
	"INSERT INTO knowledge (ts, topic, fact, confidence, state) VALUES (?, 'w1218 alpha anchor', 'alpha fact body', 0.9, 'active')",
	[Date.now()],
);
mem.run(
	"INSERT INTO knowledge (ts, topic, fact, confidence, state) VALUES (?, 'w1218 beta anchor', 'beta fact body', 0.8, 'active')",
	[Date.now()],
);
mem.run(
	"INSERT INTO knowledge_claims (evidence_id, claim, scope) VALUES ('ev-w1218', 'a claim', 'fleet')",
);
mem.run(
	"INSERT INTO knowledge_fts (rowid, topic, fact) SELECT id, topic, fact FROM knowledge",
);

const ok = (sql: string): boolean => lintReadOnlySql(sql).ok;
const refusal = (sql: string): string | undefined => lintReadOnlySql(sql).error;

test.describe("lintReadOnlySql — read shapes pass", () => {
	test("plain SELECT over an allowlisted table", () => {
		expect(ok("SELECT id, topic FROM knowledge")).toBe(true);
	});
	test("CTE + join across the allowlisted set", () => {
		expect(
			ok(
				"WITH recent AS (SELECT id FROM knowledge WHERE ts > 1) SELECT k.topic FROM knowledge k JOIN recent r ON r.id = k.id",
			),
		).toBe(true);
	});
	test("CTE name as a FROM target is not a table lookup", () => {
		const l = lintReadOnlySql("WITH k AS (SELECT 1 AS x) SELECT * FROM k");
		expect(l.ok).toBe(true);
		expect(l.tables).toEqual([]);
	});
	test("subquery in FROM", () => {
		expect(ok("SELECT t.topic FROM (SELECT topic FROM knowledge) t")).toBe(
			true,
		);
	});
	test("semicolon inside a string literal never splits statements", () => {
		expect(
			ok("SELECT fact FROM knowledge WHERE fact LIKE '%; drop table%'"),
		).toBe(true);
	});
	test("FTS MATCH over the virtual table", () => {
		expect(
			ok("SELECT topic FROM knowledge_fts WHERE knowledge_fts MATCH 'w1218'"),
		).toBe(true);
	});
	test("LIMIT ... OFFSET passes with plain integers", () => {
		expect(ok("SELECT 1 LIMIT 10 OFFSET 2")).toBe(true);
	});
	test("comma LIMIT form (offset, count) passes", () => {
		expect(ok("SELECT 1 LIMIT 5, 20")).toBe(true);
	});
});

test.describe("lintReadOnlySql — refusals", () => {
	test("write/DDL verbs refuse 400 (first-word or vocabulary)", () => {
		for (const sql of [
			"INSERT INTO knowledge (topic) VALUES ('x')",
			"UPDATE knowledge SET fact = 'x'",
			"DELETE FROM knowledge WHERE id = 1",
			"DROP TABLE knowledge",
			"PRAGMA table_info(knowledge)",
			"VACUUM",
			"ATTACH DATABASE '/tmp/x.db' AS x",
		]) {
			const e = refusal(sql);
			expect(typeof e).toBe("string");
		}
	});
	test("forbidden vocabulary inside the statement names the verb", () => {
		expect(refusal("SELECT * FROM knowledge FOR UPDATE")).toMatch(
			/refused: update/,
		);
	});
	test("multi-statement refuses", () => {
		expect(refusal("SELECT 1; SELECT 2")).toBe("single statement only");
	});
	test("non-SELECT lead refuses", () => {
		expect(refusal("EXPLAIN SELECT 1")).toBe("SELECT or WITH statements only");
	});
	test("unterminated string literal fails closed", () => {
		expect(refusal("SELECT 'unterminated")).toBe(
			"unterminated literal or comment",
		);
	});
	test("sqlite_master and unknown tables refuse", () => {
		expect(refusal("SELECT * FROM sqlite_master")).toMatch(/not allowlisted/);
		expect(refusal("SELECT * FROM knowledge_queue")).toMatch(/not allowlisted/);
	});
	test("table-valued functions refuse", () => {
		expect(refusal("SELECT * FROM json_each('[1,2]')")).toMatch(
			/not allowlisted/,
		);
	});
	test("schema-qualified refs refuse", () => {
		expect(refusal("SELECT * FROM main.knowledge")).toMatch(/schema-qualified/);
	});
	test("expression / parameter / negative LIMITs refuse", () => {
		expect(refusal("SELECT 1 LIMIT 1 + 1")).toMatch(/plain integer/);
		expect(refusal("SELECT 1 LIMIT ?")).toMatch(/plain integer/);
		expect(refusal("SELECT 1 LIMIT :n")).toMatch(/named parameters/);
		expect(refusal("SELECT 1 LIMIT -1")).toMatch(/plain integer/);
		expect(refusal("SELECT 1 LIMIT 1999+1")).toMatch(/plain integer/);
	});
	test("named parameter shapes refuse (positional ? only)", () => {
		expect(refusal("SELECT id FROM knowledge WHERE topic LIKE :pat")).toMatch(
			/named parameters/,
		);
	});
	test("LIMIT past the cap refuses", () => {
		expect(refusal(`SELECT 1 LIMIT ${KNOWLEDGE_LIMIT_MAX + 1}`)).toMatch(
			/exceeds the cap/,
		);
	});
});

test.describe("executeKnowledgeSql — the ro executor", () => {
	test("appends LIMIT when the statement carries none", () => {
		const r = executeKnowledgeSql(mem, "SELECT id, topic FROM knowledge", {
			limit: 5,
		});
		expect(r.ok).toBe(true);
		expect(r.executedSql?.endsWith("LIMIT 5")).toBe(true);
		expect(r.rowCount).toBe(2);
		expect(r.limit).toBe(5);
		expect((r.elapsedMs ?? 0) < 2000).toBe(true);
	});
	test("the statement's own LIMIT wins", () => {
		const r = executeKnowledgeSql(mem, "SELECT id FROM knowledge LIMIT 1");
		expect(r.ok).toBe(true);
		expect(r.limit).toBe(1);
		expect(r.rowCount).toBe(1);
	});
	test("positional parameters bind", () => {
		const r = executeKnowledgeSql(
			mem,
			"SELECT id FROM knowledge WHERE topic LIKE ?",
			{ params: ["%beta%"], limit: 10 },
		);
		expect(r.ok).toBe(true);
		expect(r.rowCount).toBe(1);
	});
	test("named parameter shapes fail at execution (positional only)", () => {
		const r = executeKnowledgeSql(
			mem,
			"SELECT id FROM knowledge WHERE topic LIKE :pat",
			{},
		);
		expect(r.ok).toBe(false);
		expect(r.status).toBe(400);
	});
	test("executor clamps an absurd caller limit", () => {
		const r = executeKnowledgeSql(mem, "SELECT id FROM knowledge", {
			limit: 10_000,
		});
		expect(r.limit).toBe(KNOWLEDGE_LIMIT_MAX);
	});
	test("execution errors answer 400, not 500", () => {
		const r = executeKnowledgeSql(mem, "SELECT nope FROM knowledge");
		expect(r.status).toBe(400);
	});
});

// ─── buckle verify client ───────────────────────────────────────────────────
const stubFetch = (body: unknown, status = 200): typeof fetch =>
	(async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
const boomFetch = ((): typeof fetch =>
	(async () => {
		throw new Error("conn refused");
	})()) as unknown as typeof fetch;

test.describe("verifyKnowledgeKey — buckle verify client", () => {
	const o = {
		front: "http://127.0.0.1:1",
		admin: "bksk_admin",
		timeoutMs: 500,
	};
	test("missing / non-bksk_ key = 401 before any network call", async () => {
		expect(
			await verifyKnowledgeKey(null, KNOWLEDGE_READ_SCOPE, o),
		).toMatchObject({
			ok: false,
			status: 401,
			code: "knowledge.auth_missing",
		});
		const nonKey = await verifyKnowledgeKey(
			"tok-not-bksk",
			KNOWLEDGE_READ_SCOPE,
			o,
		);
		expect(nonKey.status).toBe(401);
	});
	test("no admin credential = 503 fail closed", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_READ_SCOPE, {
			...o,
			admin: null,
		});
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			code: "knowledge.verify_unconfigured",
		});
	});
	test("verify backend 5xx = 503", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_READ_SCOPE, {
			...o,
			fetchFn: stubFetch({ error: "down" }, 500),
		});
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			code: "knowledge.verify_backend_500",
		});
	});
	test("invalid key = 401 with the buckle code", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_READ_SCOPE, {
			...o,
			fetchFn: stubFetch({ valid: false, code: "buckle.key_invalid" }),
		});
		expect(r).toMatchObject({
			ok: false,
			status: 401,
			code: "buckle.key_invalid",
		});
	});
	test("valid key + face scope = verified, keyId carried", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_READ_SCOPE, {
			...o,
			fetchFn: stubFetch({
				valid: true,
				key_id: "k-42",
				scopes: [KNOWLEDGE_READ_SCOPE],
			}),
		});
		expect(r).toMatchObject({ ok: true, status: 200, keyId: "k-42" });
	});
	test("valid key WITHOUT the face scope = 403", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_QUERY_SCOPE, {
			...o,
			fetchFn: stubFetch({ valid: true, scopes: [KNOWLEDGE_READ_SCOPE] }),
		});
		expect(r).toMatchObject({
			ok: false,
			status: 403,
			code: "knowledge.insufficient_scope",
		});
	});
	test("verify leg throwing = 503 fail closed", async () => {
		const r = await verifyKnowledgeKey("bksk_x", KNOWLEDGE_READ_SCOPE, {
			...o,
			fetchFn: boomFetch,
		});
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			code: "knowledge.verify_unreachable",
		});
	});
});

// ─── the NL translator ──────────────────────────────────────────────────────
const llmConf = (): Parameters<typeof translateQuestion>[1] => ({
	sqlLlmUrl: "http://127.0.0.1:1",
	sqlLlmModel: "sql-test",
	sqlLlmKey: null,
	sqlLlmTimeoutMs: 500,
});
const llmStubFetch = (content: unknown, status = 200): typeof fetch =>
	(async () =>
		new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
			status,
		})) as unknown as typeof fetch;
const ask = (
	q: string,
	content: unknown,
	status = 200,
): ReturnType<typeof translateQuestion> =>
	translateQuestion(q, llmConf(), llmStubFetch(content, status));

test.describe("translateQuestion — the pinned SQL LLM client", () => {
	test("empty question = 400", async () => {
		const r = await ask("   ", "SELECT 1");
		expect(r).toMatchObject({ ok: false, status: 400 });
	});
	test("unconfigured translator = 503", async () => {
		const r = await translateQuestion("q", {
			sqlLlmUrl: null,
			sqlLlmModel: "sql",
			sqlLlmKey: null,
			sqlLlmTimeoutMs: 100,
		});
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			error: "knowledge.query_unconfigured",
		});
	});
	test("fenced sql extracted and lint-passing", async () => {
		const r = await ask(
			"how many anchors",
			["```sql", "SELECT COUNT(*) FROM knowledge", "```"].join("\n"),
		);
		expect(r.ok).toBe(true);
		expect(r.sql).toBe("SELECT COUNT(*) FROM knowledge");
		expect(r.lint?.ok).toBe(true);
	});
	test("model emits a write shape = 422 (the lint is the law)", () => {
		const evil = ["INS", "ERT INTO knowledge (topic) VALUES ('x')"].join("");
		return ask("evil", evil).then((r) => {
			expect(r.status).toBe(422);
			expect(r.error).toMatch(/SELECT or WITH statements only/);
		});
	});
	test("garbage without a fence = 422", async () => {
		const r = await ask("q", "I cannot answer that.");
		expect(r.status).toBe(422);
	});
	test("backend 500 = 503 with the backend code", async () => {
		const r = await ask("q", "SELECT 1", 500);
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			error: "knowledge.llm_backend_500",
		});
	});
	test("malformed answer body = 503", async () => {
		const r = await ask("q", undefined);
		expect(r).toMatchObject({
			ok: false,
			status: 503,
			error: "knowledge.llm_malformed",
		});
	});
});

test.describe("answerKnowledgeQuestion — translate + execute composition", () => {
	const askMem = (
		q: string,
		content: unknown,
	): ReturnType<typeof answerKnowledgeQuestion> =>
		answerKnowledgeQuestion(mem, q, llmConf(), {
			fetchFn: llmStubFetch(content),
		});
	test("question → rows + sql + combined elapsed", async () => {
		const r = await askMem(
			"list the anchors",
			[
				"```sql",
				"SELECT topic FROM knowledge WHERE topic LIKE '%w1218%'",
				"```",
			].join("\n"),
		);
		expect(r.ok).toBe(true);
		expect(r.rowCount).toBe(2);
		expect(r.sql).toContain("LIKE");
		expect((r.elapsedMs ?? 0) < 2000).toBe(true);
	});
	test("translator refusal surfaces 422", async () => {
		const evil = ["UPD", "ATE knowledge SET fact = 'x'"].join("");
		const r = await askMem("evil", evil);
		expect(r.status).toBe(422);
	});
});

test.describe("knowledgeQueryConf — env resolution", () => {
	test("defaults + empty-string env counts as absent", () => {
		const c = knowledgeQueryConf({});
		expect(c.front).toBe("http://127.0.0.1:4101");
		expect(c.sqlLlmUrl).toBeNull();
		expect(c.sqlLlmModel).toBe("sql");
		const pinned = knowledgeQueryConf({
			SUSPENDERS_SQL_LLM_URL: "",
			SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN: "bksk_env",
		});
		expect(pinned.admin).toBe("bksk_env");
	});
});

// ─── API-level: the live faces (real bin, stub buckle front + stub LLM) ─────
const VPORT = unusedPort();
const LPORT = unusedPort();
const EPORT = unusedPort();
const EBASE = `http://127.0.0.1:${EPORT}`;
const GOOD_KEY = "bksk_w1218_good";
const QUERY_ONLY_KEY = "bksk_w1218_queryonly";
const READ_ONLY_KEY = "bksk_w1218_readonly";
const BAD_KEY = "bksk_w1218_bad";
const VERIFY_URL = `http://127.0.0.1:${VPORT}`;
const LLM_URL = `http://127.0.0.1:${LPORT}`;
const HOME = mkdtempSync(join(tmpdir(), "w1218-home-"));
const E2E_REPO = mkdtempSync(join(tmpdir(), "w1218-repo-"));
const GOVDB_TS = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"govdb",
	"govdb.ts",
);
const KB_PATH = join(HOME, ".cache", "claude-governor", "knowledge.db");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const GOOD_SQL = "SELECT id, topic FROM knowledge WHERE topic LIKE '%w1218%'";
// the placeholder form: /knowledge/sql binds params positionally — a literal
// pattern + a bound param would be an unbound-placeholder mismatch (SQLITE_RANGE)
const PARAM_SQL = "SELECT id, topic FROM knowledge WHERE topic LIKE ?";
const FENCE = (sql: string): string => `\`\`\`sql\n${sql}\n\`\`\``;

// seed through the REAL migration path in a subprocess (HOME-isolated):
// openGovernorDb runs the ladder → creates knowledge.db, then seed 2 rows.
const SEED_SCRIPT = [
	"const m = await import(process.env.W1218_GOVDB);",
	// the REAL ladder: openGovernorDb runs the v10 knowledge split, which is
	// what actually creates kb.knowledge in knowledge.db (a bare
	// openKnowledgeDb() on a fresh file leaves the base tables absent).
	"const kb = m.openGovernorDb();",
	// the ladder detaches kb after the split — re-attach knowledge.db for
	// the seed INSERTs (the faces' ro handle reads the same physical file).
	'kb.run("ATTACH DATABASE ? AS kb", [process.env.W1218_KB]);',
	"const now = Date.now();",
	[
		"kb.run(\"INSERT INTO kb.knowledge (ts, topic, fact, confidence, state, domain, origin_kind, created_at, updated_at) VALUES (?, ?, ?, 0.9, 'active', 'suspenders', 'decision', ?, ?)\",",
		"[now, 'w1218 alpha anchor', 'alpha fact body for the query face', now, now]);",
	].join(" "),
	[
		"kb.run(\"INSERT INTO kb.knowledge (ts, topic, fact, confidence, state, domain, origin_kind, created_at, updated_at) VALUES (?, ?, ?, 0.8, 'active', 'suspenders', 'decision', ?, ?)\",",
		"[now, 'w1218 beta anchor', 'beta fact body', now, now]);",
	].join(" "),
	"console.log('seeded');",
].join("\n");

const seed = Bun.spawnSync(["bun", "-e", SEED_SCRIPT], {
	env: { ...process.env, HOME, W1218_GOVDB: GOVDB_TS, W1218_KB: KB_PATH },
	stdout: "pipe",
	stderr: "pipe",
});
if (!seed.stdout.toString().includes("seeded")) {
	console.error("seed failed:", seed.stderr.toString(), seed.stdout.toString());
}

// the stub buckle verify front: key → verdict map over real HTTP.
const verifyStub = Bun.serve({
	port: VPORT,
	fetch: async (req) => {
		if (new URL(req.url).pathname !== "/v1/admin/keys/verify")
			return new Response("not found", { status: 404 });
		const b = (await req.json().catch(() => ({}))) as { key?: string };
		const verdicts: Record<string, Record<string, unknown>> = {
			[GOOD_KEY]: {
				valid: true,
				key_id: "k-good",
				scopes: [KNOWLEDGE_QUERY_SCOPE, KNOWLEDGE_READ_SCOPE],
			},
			[QUERY_ONLY_KEY]: {
				valid: true,
				key_id: "k-q",
				scopes: [KNOWLEDGE_QUERY_SCOPE],
			},
			[READ_ONLY_KEY]: {
				valid: true,
				key_id: "k-r",
				scopes: [KNOWLEDGE_READ_SCOPE],
			},
		};
		const v = verdicts[b.key ?? ""] ?? {
			valid: false,
			code: "buckle.key_invalid",
		};
		return new Response(JSON.stringify(v), {
			headers: { "content-type": "application/json" },
		});
	},
});

// the stub SQL LLM (OpenAI wire): fenced SELECT for keyword questions, a
// write shape for the evil question, 500 for the backend-fail marker.
const llmStub = Bun.serve({
	port: LPORT,
	fetch: async (req) => {
		const b = (await req.json().catch(() => ({}))) as {
			messages?: { role: string; content: string }[];
		};
		const q = b.messages?.find((m) => m.role === "user")?.content ?? "";
		const evil = ["INS", "ERT INTO knowledge (topic) VALUES ('hax')"].join("");
		const content = q.includes("evil")
			? evil
			: q.includes("backend-fail")
				? ""
				: FENCE(GOOD_SQL);
		return new Response(
			JSON.stringify({ choices: [{ message: { content } }] }),
			{
				status: q.includes("backend-fail") ? 500 : 200,
				headers: { "content-type": "application/json" },
			},
		);
	},
});

const proc = Bun.spawn(["bun", API_TS], {
	env: {
		...process.env,
		HOME,
		KNOWLEDGE_API_PORT: String(EPORT),
		SUSPENDERS_KNOWLEDGE_VERIFY_URL: VERIFY_URL,
		SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN: "bksk_admin_w1218",
		SUSPENDERS_SQL_LLM_URL: LLM_URL,
		SUSPENDERS_SQL_LLM_MODEL: "sql-test",
	},
	cwd: E2E_REPO,
	stdout: "pipe",
	stderr: "pipe",
});
// drain continuously — reading only after exit loses pipe output
const stderrDone = new Response(proc.stderr).text();
let bootOk = false;
const up = async (): Promise<boolean> => {
	for (let i = 0; i < 60; i++) {
		if (
			await fetch(`${EBASE}/health`)
				.then((r) => r.ok)
				.catch(() => false)
		)
			return true;
		await Bun.sleep(150);
	}
	return false;
};

test.afterAll(async () => {
	proc.kill();
	verifyStub.stop(true);
	llmStub.stop(true);
	const err = await stderrDone.catch(() => "");
	if (!bootOk) console.error("api stderr:", err.slice(0, 2000));
	rmSync(HOME, { recursive: true, force: true });
	rmSync(E2E_REPO, { recursive: true, force: true });
});

const face = async (
	path: "query" | "sql",
	body: Record<string, unknown>,
	key?: string,
): Promise<{
	status: number;
	data: Record<string, unknown>;
	faceHeader: string | null;
}> => {
	const res = await fetch(`${EBASE}/knowledge/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
		faceHeader: res.headers.get("x-klh-face"),
	};
};

test.describe("knowledge faces — live boot + auth matrix", () => {
	test("boots with both faces advertised on /health", async () => {
		bootOk = await up();
		expect(bootOk).toBe(true);
		const h = (await (await fetch(`${EBASE}/health`)).json()) as {
			routes: string[];
		};
		expect(h.routes).toContain("/knowledge/query");
		expect(h.routes).toContain("/knowledge/sql");
	});
	test("unkeyed / non-bksk_ key = 401, face header stamped", async () => {
		for (const key of [undefined, "not-a-key"]) {
			const r = await face("sql", { sql: GOOD_SQL }, key);
			expect(r.status).toBe(401);
			expect(r.faceHeader).toBe("knowledge/sql");
			expect(r.data.error).toBe("knowledge.auth_missing");
		}
	});
	test("invalid key (verify refuses) = 401 with the buckle code", async () => {
		const r = await face("sql", { sql: GOOD_SQL }, BAD_KEY);
		expect(r.status).toBe(401);
		expect(r.data.error).toBe("buckle.key_invalid");
	});
	test("valid key without the face scope = 403", async () => {
		const r = await face("sql", { sql: GOOD_SQL }, QUERY_ONLY_KEY);
		expect(r.status).toBe(403);
		expect(r.data.error).toBe("knowledge.insufficient_scope");
		expect(r.faceHeader).toBe("knowledge/sql");
	});
});

test.describe("/knowledge/sql — the direct read-only face", () => {
	test("parameterized SELECT returns rows under 2s", async () => {
		const t0 = Date.now();
		const r = await face(
			"sql",
			{ sql: PARAM_SQL, params: ["%w1218%"], limit: 10 },
			READ_ONLY_KEY,
		);
		expect(r.status).toBe(200);
		expect(r.data.rowCount).toBe(2);
		expect(r.data.executedSql).toBe(`${PARAM_SQL}\nLIMIT 10`);
		expect(r.faceHeader).toBe("knowledge/sql");
		expect(Date.now() - t0).toBeLessThan(2000);
	});
	test("write shapes refuse 4xx", async () => {
		for (const sql of [
			"INSERT INTO knowledge (topic) VALUES ('x')",
			"UPDATE knowledge SET fact = 'x'",
			"DELETE FROM knowledge",
			"ATTACH DATABASE '/tmp/x' AS x",
		]) {
			const r = await face("sql", { sql }, READ_ONLY_KEY);
			expect(r.status).toBe(400);
		}
	});
	test("unknown tables refuse", async () => {
		for (const sql of [
			"SELECT * FROM sqlite_master",
			"SELECT * FROM knowledge_queue",
			"SELECT * FROM main.knowledge",
		]) {
			const r = await face("sql", { sql }, READ_ONLY_KEY);
			expect(r.status).toBe(400);
		}
	});
});

test.describe("/knowledge/query — the NL face", () => {
	test("question returns rows + the SQL that produced them", async () => {
		const r = await face(
			"query",
			{ question: "show the w1218 anchors" },
			GOOD_KEY,
		);
		expect(r.status).toBe(200);
		expect(r.data.rowCount).toBe(2);
		expect(r.data.sql).toBe(GOOD_SQL);
		expect(r.data.executedSql).toBe(`${GOOD_SQL}\nLIMIT 200`);
		expect(r.faceHeader).toBe("knowledge/query");
		expect(r.data.elapsedMs as number).toBeLessThan(2000);
	});
	test("model emitting a write shape = 422 (the lint is the law)", async () => {
		const r = await face("query", { question: "evil" }, GOOD_KEY);
		expect(r.status).toBe(422);
		expect(r.data.error).toMatch(/SELECT or WITH statements only/);
	});
	test("LLM backend failure = 503", async () => {
		const r = await face(
			"query",
			{ question: "backend-fail please" },
			GOOD_KEY,
		);
		expect(r.status).toBe(503);
		expect(r.data.error).toBe("knowledge.llm_backend_500");
	});
	test("unkeyed query face = 401", async () => {
		const r = await face("query", { question: "anything" });
		expect(r.status).toBe(401);
		expect(r.faceHeader).toBe("knowledge/query");
	});
});
