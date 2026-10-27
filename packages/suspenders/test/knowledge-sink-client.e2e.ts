// test/knowledge-sink-client.test.ts — W1221: the ONE sink client — conf
// resolution, both recall faces (injected fetch), and a live-boot e2e where a
// FRESH spawned process holding only url+key env answers a fleet-knowledge
// question through the real knowledge-api bin (stub buckle + stub LLM).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	type SinkConf,
	querySink,
	readSinkKey,
	searchSink,
	sinkConf,
	sinkConfigured,
} from "../hooks/lib/knowledge/knowledge-sink-client.ts";

const baseConf = (over: Partial<SinkConf> = {}): SinkConf => ({
	url: "http://127.0.0.1:1",
	key: null,
	keyFile: null,
	timeoutMs: 250,
	...over,
});

test.describe("sink conf resolution", () => {
	test("blank url counts as absent — unconfigured", () => {
		const c = sinkConf({
			SUSPENDERS_KNOWLEDGE_SINK_URL: "  ",
		} as NodeJS.ProcessEnv);
		expect(c.url).toBeNull();
		expect(sinkConfigured(c)).toBe(false);
	});
	test("timeout defaults to 2000, env overrides", () => {
		expect(sinkConf({} as NodeJS.ProcessEnv).timeoutMs).toBe(2000);
		expect(
			sinkConf({
				SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS: "400",
			} as NodeJS.ProcessEnv).timeoutMs,
		).toBe(400);
	});
	test("readSinkKey: env key wins, then the 0600 key file, then null", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1221-key-"));
		const kf = join(dir, "sink.key");
		writeFileSync(kf, "bksk_fromfile\n");
		try {
			expect(readSinkKey(baseConf({ key: "bksk_env" }))).toBe("bksk_env");
			expect(readSinkKey(baseConf({ keyFile: kf }))).toBe("bksk_fromfile");
			expect(
				readSinkKey(baseConf({ keyFile: join(dir, "missing.key") })),
			).toBeNull();
			expect(readSinkKey(baseConf())).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test.describe("searchSink (injected fetch)", () => {
	test("unconfigured → ok:false, no throw", async () => {
		const out = await searchSink("anything", baseConf({ url: null }));
		expect(out.ok).toBe(false);
		expect(out.error).toBe("sink not configured");
	});
	test("cards render the answer (string face form, array tolerated); hits pass through", async () => {
		const calls: { url: string; body: string }[] = [];
		const fetchFn = async (url: string, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: String(init?.body ?? ""),
			});
			return new Response(
				JSON.stringify({
					cards: "fleet knowledge — 1 hit for: w1221\nk#1 · w1221 alpha anchor",
					hits: [{ topic: "t" }],
				}),
			);
		};
		const out = await searchSink("w1221", baseConf(), fetchFn as typeof fetch);
		expect(out.ok).toBe(true);
		expect(out.answer).toContain("w1221 alpha anchor");
		expect(out.hits).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:1/search");
		expect(calls[0].body).toBe(JSON.stringify({ query: "w1221", limit: 5 }));
		const arrayForm = await searchSink(
			"w1221",
			baseConf(),
			(async () =>
				new Response(JSON.stringify({ cards: ["a", "b"] }))) as typeof fetch,
		);
		expect(arrayForm.answer).toBe("a\n\nb");
	});
	test("HTTP 503 and thrown fetch both fail open with an error", async () => {
		const failing = async (): Promise<Response> =>
			new Response("down", { status: 503 });
		const out503 = await searchSink("q", baseConf(), failing as typeof fetch);
		expect(out503.ok).toBe(false);
		expect(out503.error).toBe("HTTP 503");
		const thrown = async (): Promise<Response> => {
			throw new Error("econnrefused");
		};
		const outErr = await searchSink("q", baseConf(), thrown as typeof fetch);
		expect(outErr.ok).toBe(false);
		expect(outErr.error).toBe("econnrefused");
	});
});

test.describe("querySink (injected fetch)", () => {
	test("no url or no key refuses locally (status 0)", async () => {
		expect((await querySink("q", baseConf({ url: null }))).error).toBe(
			"sink not configured",
		);
		expect((await querySink("q", baseConf())).error).toBe("no sink key");
	});
	test("success carries rows, rowCount, sql", async () => {
		const fetchFn = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					rows: [{ topic: "w1221 alpha anchor" }],
					rowCount: 1,
					sql: "SELECT 1",
					elapsedMs: 3,
				}),
			);
		const out = await querySink(
			"show the w1221 anchors",
			baseConf({ key: "bksk_k" }),
			fetchFn as typeof fetch,
		);
		expect(out.ok).toBe(true);
		expect(out.status).toBe(200);
		expect(out.rowCount).toBe(1);
		expect(out.sql).toBe("SELECT 1");
	});
	test("401 carries the server's buckle error", async () => {
		const fetchFn = async (): Promise<Response> =>
			new Response(JSON.stringify({ error: "buckle.key_invalid" }), {
				status: 401,
			});
		const out = await querySink(
			"q",
			baseConf({ key: "bksk_bad" }),
			fetchFn as typeof fetch,
		);
		expect(out.ok).toBe(false);
		expect(out.status).toBe(401);
		expect(out.error).toBe("buckle.key_invalid");
	});
});

// ─── e2e: a FRESH process answers a fleet-knowledge question via the sink ───
const unusedPort = (): number => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("probe") });
	const p = s.port;
	s.stop(true);
	return p;
};
const VPORT = unusedPort();
const LPORT = unusedPort();
const EPORT = unusedPort();
const EBASE = `http://127.0.0.1:${EPORT}`;
const VERIFY_URL = `http://127.0.0.1:${VPORT}`;
const LLM_URL = `http://127.0.0.1:${LPORT}`;
const HOME = mkdtempSync(join(tmpdir(), "w1221-home-"));
const GOVDB_TS = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"govdb",
	"govdb.ts",
);
const CLIENT_TS = join(
	import.meta.dir,
	"..",
	"hooks",
	"lib",
	"knowledge",
	"knowledge-sink-client.ts",
);
const KB_PATH = join(HOME, ".cache", "claude-governor", "knowledge.db");
const API_TS = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
const GOOD_KEY = "bksk_w1221_good";
const GOOD_SQL = "SELECT id, topic FROM knowledge WHERE topic LIKE '%w1221%'";
const FENCE = (sql: string): string => `\`\`\`sql\n${sql}\n\`\`\``;

// seed through the REAL migration path in a subprocess (HOME-isolated), then
// attach kb for the INSERTs — mirrors the W1218 e2e's fresh-seed contract.
const SEED_SCRIPT = [
	"const m = await import(process.env.W1221_GOVDB);",
	"const kb = m.openGovernorDb();",
	'kb.run("ATTACH DATABASE ? AS kb", [process.env.W1221_KB]);',
	"const now = Date.now();",
	[
		"kb.run(\"INSERT INTO kb.knowledge (ts, topic, fact, confidence, state, domain, origin_kind, created_at, updated_at) VALUES (?, ?, ?, 0.9, 'active', 'suspenders', 'decision', ?, ?)\",",
		"[now, 'w1221 alpha anchor', 'alpha fact body for the query face', now, now]);",
	].join(" "),
	[
		"kb.run(\"INSERT INTO kb.knowledge (ts, topic, fact, confidence, state, domain, origin_kind, created_at, updated_at) VALUES (?, ?, ?, 0.8, 'active', 'suspenders', 'decision', ?, ?)\",",
		"[now, 'w1221 beta anchor', 'beta fact body', now, now]);",
	].join(" "),
	"console.log('seeded');",
].join("\n");

const seed = Bun.spawnSync(["bun", "-e", SEED_SCRIPT], {
	env: { ...process.env, HOME, W1221_GOVDB: GOVDB_TS, W1221_KB: KB_PATH },
	stdout: "pipe",
	stderr: "pipe",
});
if (!seed.stdout.toString().includes("seeded"))
	console.error("w1221 seed failed:", seed.stderr.toString());

// the stub buckle verify front: one good QUERY_-scoped key, all else refused.
const verifyStub = Bun.serve({
	port: VPORT,
	fetch: async (req) => {
		if (new URL(req.url).pathname !== "/v1/admin/keys/verify")
			return new Response("not found", { status: 404 });
		const b = (await req.json().catch(() => ({}))) as { key?: string };
		const v =
			b.key === GOOD_KEY
				? {
						valid: true,
						key_id: "k-w1221",
						scopes: ["buckle:knowledge:QUERY_", "buckle:knowledge:READ_"],
					}
				: { valid: false, code: "buckle.key_invalid" };
		return new Response(JSON.stringify(v), {
			headers: { "content-type": "application/json" },
		});
	},
});

// the stub SQL LLM: fenced SELECT for any question (the seed topics carry the
// w1221 marker the GOOD_SQL pattern matches).
const llmStub = Bun.serve({
	port: LPORT,
	fetch: async (req) => {
		const b = (await req.json().catch(() => ({}))) as {
			messages?: { role: string; content: string }[];
		};
		void b;
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: FENCE(GOOD_SQL) } }],
			}),
			{ headers: { "content-type": "application/json" } },
		);
	},
});

// the REAL knowledge-api bin under test — env-pinned to the stubs.
const proc = Bun.spawn(["bun", API_TS], {
	env: {
		...process.env,
		HOME,
		KNOWLEDGE_API_PORT: String(EPORT),
		SUSPENDERS_KNOWLEDGE_VERIFY_URL: VERIFY_URL,
		SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN: "bksk_admin_w1221",
		SUSPENDERS_SQL_LLM_URL: LLM_URL,
		SUSPENDERS_SQL_LLM_MODEL: "sql-test",
	},
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

// THE ACCEPTANCE: a fresh spawned process holding only url+key env imports
// the ONE client and answers a fleet-knowledge question via the live sink.
const CHILD_SCRIPT = [
	"const m = await import(process.env.W1221_CLIENT);",
	'const q = await m.querySink("show the w1221 anchor facts");',
	'const s = await m.searchSink("w1221 anchor");',
	"console.log(JSON.stringify({ q, s }));",
].join("\n");

const runChild = async (
	env: Record<string, string>,
): Promise<{ q: Record<string, unknown>; s: Record<string, unknown> }> => {
	const p = Bun.spawn(["bun", "-e", CHILD_SCRIPT], {
		env: { ...process.env, HOME, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	await p.exited;
	try {
		return JSON.parse(out) as {
			q: Record<string, unknown>;
			s: Record<string, unknown>;
		};
	} catch {
		throw new Error(`child failed: ${err.slice(0, 800)}`);
	}
};

test.afterAll(async () => {
	proc.kill();
	verifyStub.stop(true);
	llmStub.stop(true);
	const err = await stderrDone.catch(() => "");
	if (!bootOk) console.error("api stderr:", err.slice(0, 2000));
	rmSync(HOME, { recursive: true, force: true });
});

test.describe("W1221 acceptance — fresh process queries the sink", () => {
	test("boots the real bin with all three faces advertised", async () => {
		bootOk = await up();
		expect(bootOk).toBe(true);
		const h = (await (await fetch(`${EBASE}/health`)).json()) as {
			routes: string[];
		};
		expect(h.routes).toContain("/knowledge/query");
		expect(h.routes).toContain("/knowledge/sql");
		expect(h.routes).toContain("/search");
	}, 30_000);
	test("fresh child (url+key env only) answers a fleet-knowledge question", async () => {
		expect(bootOk).toBe(true);
		const { q, s } = await runChild({
			SUSPENDERS_KNOWLEDGE_SINK_URL: EBASE,
			SUSPENDERS_KNOWLEDGE_KEY: GOOD_KEY,
			W1221_CLIENT: CLIENT_TS,
		});
		expect(q.ok).toBe(true);
		expect(q.rowCount).toBe(2);
		expect(String(q.sql)).toContain("w1221");
		expect(s.ok).toBe(true);
		expect(String(s.answer)).toContain("w1221");
	}, 30_000);
	test("fresh child rides the key FILE when no raw key env is set", async () => {
		const kf = join(HOME, "sink.key");
		writeFileSync(kf, `${GOOD_KEY}\n`);
		const { q } = await runChild({
			SUSPENDERS_KNOWLEDGE_SINK_URL: EBASE,
			SUSPENDERS_KNOWLEDGE_KEY_FILE: kf,
			W1221_CLIENT: CLIENT_TS,
		});
		expect(q.ok).toBe(true);
		expect(q.rowCount).toBe(2);
	}, 30_000);
});
