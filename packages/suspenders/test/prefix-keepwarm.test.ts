// test/prefix-keepwarm.test.ts — W623: the prefix keepwarm's pure seams +
// one live-listener capture pass against a stub front. HOME/PREFIX_* redirects
// keep every path off the real machine config; no real lane is spawned.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capturePrefix,
	extractPrefix,
	loadPrefix,
	savePrefix,
	warmBody,
	warmOnce,
	reportCache,
	type CapturedPrefix,
} from "../hooks/bin/prefix-keepwarm.ts";
import { usageFromAnthropic } from "../../buckle/src/usage.ts";

setDefaultTimeout(20_000);

const fixture: CapturedPrefix = {
	capturedAt: 1,
	model: "glm-5.3-flash",
	tools: [{ name: "Read", input_schema: { type: "object" } }],
	system: [{ type: "text", text: "harness preamble" }],
};

describe("prefix capture file (W623)", () => {
	test("save + load roundtrip; missing/corrupt fails safe to null", () => {
		const dir = mkdtempSync(join(tmpdir(), "w623-pk-"));
		const path = join(dir, "prefix-cache.json");
		expect(loadPrefix(path)).toBeNull();
		writeFileSync(path, "{corrupt");
		expect(loadPrefix(path)).toBeNull();
		writeFileSync(path, JSON.stringify({ model: "m" }));
		expect(loadPrefix(path)).toBeNull(); // no tools/system — not a prefix
		savePrefix(fixture, path);
		const loaded = loadPrefix(path);
		expect(loaded).toEqual(fixture);
		rmSync(dir, { recursive: true, force: true });
	});

	test("extractPrefix keeps model/tools/system, drops messages", () => {
		const p = extractPrefix({
			model: "glm-5.3-flash",
			tools: [{ name: "t" }],
			system: "pre",
			messages: [{ role: "user", content: "secret lane turn" }],
		});
		expect(p?.model).toBe("glm-5.3-flash");
		expect(p?.tools).toEqual([{ name: "t" }]);
		expect(p?.system).toBe("pre");
		expect(JSON.stringify(p)).not.toContain("secret lane turn");
		expect(extractPrefix({ tools: [] })).toBeNull(); // no model → not a lane request
	});

	test("warmBody carries the prefix + one nonce message, max_tokens 1", () => {
		const b = warmBody(fixture, 42);
		expect(b.model).toBe("glm-5.3-flash");
		expect(b.tools).toEqual(fixture.tools);
		expect(b.system).toEqual(fixture.system);
		expect(b.max_tokens).toBe(1);
		expect(b.messages).toEqual([{ role: "user", content: "warm 42" }]);
	});
});

describe("warmOnce (W623)", () => {
	test("posts the prefix to /w/prefix-keepwarm and reports usage", async () => {
		let seen: {
			url: string;
			auth: string;
			body: Record<string, unknown>;
		} | null = null;
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seen = {
				url,
				auth: new Headers(init?.headers).get("authorization") ?? "",
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			return new Response(
				JSON.stringify({
					usage: {
						input_tokens: 56,
						output_tokens: 1,
						cache_read_input_tokens: 8576,
						cache_creation_input_tokens: 0,
					},
				}),
			);
		}) as typeof fetch;
		const w = await warmOnce({
			front: "http://front.local",
			key: "bksk_k",
			prefix: fixture,
			fetchImpl,
		});
		expect(w.verdict).toBe("pass");
		expect(w.usage?.cache_r).toBe(8576);
		expect(seen?.url).toBe("http://front.local/w/prefix-keepwarm/v1/messages");
		expect(seen?.auth).toBe("Bearer bksk_k");
		expect(seen?.body.messages).toEqual([
			{ role: "user", content: expect.stringMatching(/^warm \d+$/) },
		]);
	});

	test("no captured prefix skips; HTTP failure is a fail, not a throw", async () => {
		const skipped = await warmOnce({
			front: "f",
			key: "k",
			prefix: null,
			fetchImpl: fetch,
		});
		expect(skipped.verdict).toBe("skipped");
		const failing = await warmOnce({
			front: "http://f.local",
			key: "k",
			prefix: fixture,
			fetchImpl: (async () =>
				new Response("no", { status: 503 })) as typeof fetch,
		});
		expect(failing.verdict).toBe("fail");
	});

	test("usage extraction rides the shared buckle mapper", () => {
		expect(
			usageFromAnthropic({
				input_tokens: 10,
				cache_read_input_tokens: 90,
			})?.cache_r,
		).toBe(90);
	});
});

describe("reportCache (W623)", () => {
	test("per-lane + per-model cache shares from a temp ledger", () => {
		const dir = mkdtempSync(join(tmpdir(), "w623-ledger-"));
		const dbPath = join(dir, "buckle.db");
		const { Database } = require("bun:sqlite") as {
			Database: new (
				p: string,
			) => {
				run: (sql: string, ...p: unknown[]) => unknown;
				close: () => void;
			};
		};
		const db = new Database(dbPath);
		db.run(`CREATE TABLE route_audit (
			rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT NOT NULL DEFAULT '',
			cache_r INTEGER, cache_c INTEGER)`);
		db.run(`CREATE TABLE router_usage (
			hour_bucket TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
			model_group TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
			in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
			cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0,
			requests INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (hour_bucket, key, model_group, model))`);
		db.run(
			"INSERT INTO route_audit (rid, ts, lane, cache_r, cache_c) VALUES ('r1', ?, 'autow1', 800, 100)",
			new Date().toISOString(),
		);
		db.run(
			"INSERT INTO route_audit (rid, ts, lane, cache_r, cache_c) VALUES ('r2', ?, '', 0, 0)",
			new Date().toISOString(),
		);
		db.run(
			"INSERT INTO router_usage VALUES (?, '', 'glm', 'glm-5.3-flash', 1000, 0, 4000, 100, 5)",
			`${new Date().toISOString().slice(0, 13)}:00`,
		);
		db.close();
		const out = reportCache({ dbPath, hours: 48 });
		expect(out).toContain("lane autow1");
		expect(out).toContain("read share 78.4%");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("capturePrefix against a stub front (W623)", () => {
	const servers: Bun.Server[] = [];
	afterAll(() => {
		for (const s of servers) s.stop(true);
	});

	test("first /v1/messages is captured and forwarded verbatim", async () => {
		const bodies: string[] = [];
		const front = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				bodies.push(await req.text());
				return Response.json({ usage: { input_tokens: 1 } });
			},
		});
		servers.push(front);
		const dir = mkdtempSync(join(tmpdir(), "w623-capture-"));
		const outPath = join(dir, "prefix-cache.json");
		// The capture client: a bun -e script that plays the lane request —
		// async spawn (the spawnSync-blocks-serve lesson), base URL from env.
		const client = `const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5.3-flash", tools: [{ name: "Read" }], system: [{ type: "text", text: "harness preamble" }], messages: [{ role: "user", content: "hi" }], max_tokens: 1 }) }); console.log("client saw", r.status);`;
		const cap = await capturePrefix({
			front: `http://127.0.0.1:${front.port}`,
			key: "bksk_k",
			outPath,
			argv: ["bun", "-e", client],
			timeoutMs: 30_000,
		});
		expect(cap.captured).toBe(true);
		expect(cap.forwarded).toBe(true);
		expect(cap.prefix?.model).toBe("glm-5.3-flash");
		expect(loadPrefix(outPath)?.tools).toEqual([{ name: "Read" }]);
		// Forwarded bytes are the client's original body (verbatim pass-through).
		expect(bodies.length).toBe(1);
		expect(JSON.parse(bodies[0] ?? "{}")).toHaveProperty("messages");
		rmSync(dir, { recursive: true, force: true });
	});
});
