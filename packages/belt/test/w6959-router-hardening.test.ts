// W695.9 — W278 hardening: enqueue-after-cancel guard, TTFB-only upstream
// timeout, and the _force_dead_port env gate. Stub servers only — never the
// live :890x fleet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicSseFromOpenAi, openLocalStream } from "../bin/router-core.ts";

const enc = new TextEncoder();
const sseChunk = (text: string) =>
	`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const SSE_HEADERS = { "content-type": "text/event-stream" };

// ─── enqueue-after-cancel guard ───
describe("enqueue-after-cancel guard", () => {
	test("cancel mid-stream: onDone 'client cancelled', no post-cancel throw", async () => {
		let upstreamCancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(sseChunk("a")));
				// hold: the consumer cancels while the pump waits on read()
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		let finished: { chars: number; error?: string } | undefined;
		const reader = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_t", model: "x", routing: { port: 8901 } },
			(r) => (finished = r),
		).getReader();
		await reader.read(); // head + first delta
		await reader.cancel("bye");
		await Bun.sleep(20);
		expect(finished?.error).toBe("client cancelled");
		expect(upstreamCancelled).toBe(true);
	});

	test("chunks pushed after cancel are dropped, not enqueued", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => (release = r));
		let upstreamCancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(enc.encode(sseChunk("a")));
				await gate;
				c.enqueue(enc.encode(sseChunk("b")));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		const reader = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_t", model: "x", routing: { port: 8901 } },
			() => {},
		).getReader();
		await reader.read();
		await reader.cancel("bye");
		release?.();
		await Bun.sleep(20);
		// pre-W278 this was an unhandled rejection (enqueue on cancelled stream)
		expect(upstreamCancelled).toBe(true);
	});
});

// ─── TTFB-only timeout ───
describe("openLocalStream TTFB timeout", () => {
	test("never-opening upstream fails fast with 'ttfb timeout'", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () => new Promise<Response>(() => {}), // headers never sent
		});
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${srv.port}`,
			timeoutMs: 80,
		});
		srv.stop(true);
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.error).toContain("ttfb timeout");
	});

	test("stream that opened keeps flowing past the TTFB cap", async () => {
		const body = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(enc.encode(sseChunk("a")));
				await new Promise((r) => setTimeout(r, 200));
				c.enqueue(enc.encode(sseChunk("b")));
				c.close();
			},
		});
		const srv = Bun.serve({
			port: 0,
			fetch: () => new Response(body, { headers: SSE_HEADERS }),
		});
		const opened = await openLocalStream(
			{ port: 8901, model: "m" },
			[],
			16,
			0,
			{ base: `http://127.0.0.1:${srv.port}`, timeoutMs: 50 },
		);
		expect(opened.ok).toBe(true);
		const text = await new Response(opened.ok ? opened.body : null).text();
		srv.stop(true);
		expect(text).toContain('"content":"a"');
		expect(text).toContain('"content":"b"');
	});
});

// ─── _force_dead_port env gate (end-to-end, stub upstream) ───
describe("_force_dead_port env gate", () => {
	let stub: ReturnType<typeof Bun.serve>;
	let stubBase = "";
	const shims: Array<ReturnType<typeof Bun.spawn>> = [];
	const homes: string[] = [];
	const bases: Record<string, string> = {};

	const spawnShim = async (armed: string): Promise<string> => {
		const home = mkdtempSync(join(tmpdir(), "w6959-"));
		homes.push(home);
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "local-llm", "prefs.json"),
			JSON.stringify({ allow_cloud: false, kev: { enabled: false } }),
		);
		const s = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = s.port ?? 0;
		s.stop(true);
		const shim = Bun.spawn({
			cmd: [
				process.execPath,
				new URL("../bin/router-shim.ts", import.meta.url).pathname,
			],
			env: {
				...process.env,
				HOME: home,
				BELT_ROUTER_PORT: String(port),
				BELT_UPSTREAM_BASE: stubBase,
				BELT_RETRY_WAIT_CAP_MS: "500",
				BELT_SELFTEST: armed,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		shims.push(shim);
		const base = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) {
			const up = await fetch(`${base}/health/liveliness`)
				.then((r) => r.ok)
				.catch(() => false);
			if (up) return base;
			await Bun.sleep(50);
		}
		throw new Error("router-shim did not come up");
	};

	const post = (base: string) =>
		fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3-flash",
				max_tokens: 32,
				_force_dead_port: 8901,
				messages: [{ role: "user", content: "Reply with the word OK." }],
			}),
		});

	beforeAll(async () => {
		stub = Bun.serve({
			port: 0,
			fetch: async (req) => {
				if (req.method !== "POST") return new Response("", { status: 404 });
				const b = (await req.json()) as { stream?: boolean };
				if (b.stream)
					return new Response(`${sseChunk("OK")}\ndata: [DONE]\n\n`, {
						headers: SSE_HEADERS,
					});
				return Response.json({
					choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
					usage: { completion_tokens: 1 },
				});
			},
		});
		stubBase = `http://127.0.0.1:${stub.port}`;
		bases.disarmed = await spawnShim("");
		bases.armed = await spawnShim("1");
	});

	afterAll(() => {
		for (const s of shims) s.kill();
		stub.stop(true);
		for (const h of homes) rmSync(h, { recursive: true, force: true });
	});

	test("disarmed shim ignores _force_dead_port", async () => {
		const r = await post(bases.disarmed);
		const d = (await r.json()) as { _routing?: { note?: string } };
		expect(String(d._routing?.note ?? "")).not.toContain("forced dead");
	});

	test("BELT_SELFTEST=1 arms the hook (note carries the forced port)", async () => {
		const r = await post(bases.armed);
		const d = (await r.json()) as { _routing?: { note?: string } };
		expect(String(d._routing?.note ?? "")).toContain(
			"forced dead primary :8901",
		);
	});
});
