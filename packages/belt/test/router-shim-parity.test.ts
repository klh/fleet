// test/router-shim-parity.test.ts — W465: the ONE router (belt's
// bin/router-shim.ts) serves every client path the retired local-llm twin
// served, proven at the WIRE level: a real subprocess of the shim against a
// stub MLX backend (BELT_UPSTREAM_BASE), sandboxed HOME, ephemeral port
// (BELT_ROUTER_PORT). Covers the retired shim's client surface —
// POST /v1/messages (JSON + SSE + the arithmetic lane), liveness — plus
// belt's superset (/registry.json) and the W204 loopback-only bind law.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = new URL("../bin/router-shim.ts", import.meta.url).pathname;

const findFreePort = (): number => {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(null),
	});
	const p = s.port ?? 0;
	s.stop(true);
	return p;
};

interface StubCall {
	path: string;
	model: string | null;
	stream: boolean;
	auth: string | null;
}

// The stub MLX specialist: OpenAI wire, JSON or SSE per the request.
const stubCalls: StubCall[] = [];
const stub = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method !== "POST" || url.pathname !== "/v1/chat/completions")
			return Response.json({ error: "not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			model?: string;
			stream?: boolean;
		};
		stubCalls.push({
			path: url.pathname,
			model: body.model ?? null,
			stream: body.stream === true,
			auth: req.headers.get("authorization"),
		});
		if (body.stream === true) {
			return openaiSse();
		}
		return Response.json({
			id: "s1",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "stub says hi" },
					finish_reason: "stop",
				},
			],
		});
	},
});

/** The openai SSE the stub replays for stream:true requests. */
const openaiSse = (): Response =>
	new Response(
		[
			'data: {"id":"s1","choices":[{"index":0,"delta":{"role":"assistant","content":"stub says hi"}}]}',
			'data: {"id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
			"data: [DONE]",
		]
			.map((f) => `${f}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

// ─── the shim subprocess (W270 env seams: BELT_ROUTER_PORT for the
// side-by-side run, BELT_UPSTREAM_BASE for the stub tier, sandboxed HOME) ──

const PORT = findFreePort();
const HOME = mkdtempSync(join(tmpdir(), "w465-shim-home-"));
const proc = Bun.spawn(["bun", SHIM], {
	env: {
		...process.env,
		BELT_ROUTER_PORT: String(PORT),
		BELT_UPSTREAM_BASE: `http://127.0.0.1:${stub.port}`,
		HOME,
	},
	stdout: "ignore",
	stderr: "pipe",
});
const BASE = `http://127.0.0.1:${PORT}`;

const waitHealthy = async (): Promise<boolean> => {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${BASE}/health`);
			if (r.ok) return true;
		} catch {
			// not bound yet
		}
		await Bun.sleep(100);
	}
	return false;
};

const post = (body: unknown): Promise<Response> =>
	fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

beforeAll(async () => {
	const ok = await waitHealthy();
	expect(ok).toBe(true);
});

afterAll(() => {
	proc.kill();
	stub.stop(true);
});

describe("W465 router-shim wire contract (the one router)", () => {
	test("loopback-only bind (W204) stays in the served file", () => {
		const src = readFileSync(SHIM, "utf8");
		expect(src).toContain('hostname: "127.0.0.1"');
	});

	test("POST /v1/messages → anthropic shape, openai wire to the stub tier", async () => {
		const res = await post({
			model: "claude-sonnet-4",
			max_tokens: 40,
			messages: [{ role: "user", content: "Reply with the word OK." }],
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			id: string;
			type: string;
			role: string;
			model: string;
			content: Array<{ type: string; text: string }>;
			stop_reason: string;
			usage: { input_tokens: number };
			_routing: { port: number };
		};
		expect(out.type).toBe("message");
		expect(out.role).toBe("assistant");
		expect(out.model).toBe("claude-sonnet-4");
		expect(out.content[0]?.type).toBe("text");
		expect(out.content[0]?.text).toBe("stub says hi");
		expect(out.stop_reason).toBe("end_turn");
		expect(out.usage.input_tokens).toBe(0);
		// the stub tier answered: openai wire over BELT_UPSTREAM_BASE
		expect(out._routing.port).toBe(8902); // extract tier (registry port)
		expect(stubCalls.length).toBeGreaterThan(0);
		expect(stubCalls[0]?.model ?? "").toContain("mlx-community/");
	});

	test("SSE: anthropic event stream translated from the openai stub", async () => {
		const res = await post({
			model: "claude-sonnet-4",
			max_tokens: 40,
			stream: true,
			messages: [{ role: "user", content: "Reply OK." }],
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toContain("message_start");
		expect(text).toContain("content_block_delta");
		expect(text).toContain("message_stop");
		expect(text).toContain("stub says hi");
	});

	test("arithmetic lane answers with zero backend calls (both shims served it)", async () => {
		const before = stubCalls.length;
		const res = await post({
			model: "no-model",
			max_tokens: 16,
			messages: [
				{
					role: "user",
					content: "What is 12*12? Answer with the number only.",
				},
			],
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			content: Array<{ text: string }>;
			_routing: { category?: string };
		};
		expect(out.content[0]?.text).toBe("144");
		expect(stubCalls.length).toBe(before);
	});
});

describe("W465 router-shim surfaces (liveness, registry, refusal shapes)", () => {
	test("health liveness + /registry.json superset face", async () => {
		const health = await fetch(`${BASE}/health`);
		expect(health.status).toBe(200);
		const h = (await health.json()) as { service: string; status: string };
		expect(h.service).toBe("belt-router");
		expect(h.status).toBe("alive");
		const reg = await fetch(`${BASE}/registry.json`);
		expect(reg.status).toBe(200);
		const doc = (await reg.json()) as { version: number; entries: unknown[] };
		expect(doc.version).toBe(1);
		expect(doc.entries.length).toBeGreaterThanOrEqual(5);
	});

	test("404 unknown route; 404 GET /v1/messages; 400 bad json", async () => {
		const miss = await fetch(`${BASE}/nope`);
		expect(miss.status).toBe(404);
		const get = await fetch(`${BASE}/v1/messages`);
		expect(get.status).toBe(404);
		const bad = await fetch(`${BASE}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{broken",
		});
		expect(bad.status).toBe(400);
	});
});
