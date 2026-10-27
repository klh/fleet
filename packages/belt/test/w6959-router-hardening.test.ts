// W695.9 — W278 hardening: enqueue-after-cancel guard, TTFB-only upstream
// timeout, and the _force_dead_port env gate. Stub servers only — never the
// live :890x fleet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicSseFromOpenAi, openLocalStream } from "../bin/router-core.ts";
import {
	freePort,
	scratchWorld,
	serveStub,
	waitUp,
} from "@klh/test-kit";

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

	test("cancel mid-stream: onDone fires exactly once (double-done guard)", async () => {
		let onDoneCalls = 0;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(sseChunk("a")));
			},
		});
		const reader = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_t", model: "x", routing: { port: 8901 } },
			() => {
				onDoneCalls++;
			},
		).getReader();
		await reader.read(); // head + first delta
		await reader.cancel("bye");
		await Bun.sleep(20);
		// cancel's done('client cancelled') and the eof-wake's done() must not
		// double-fire — the finished latch is the W278 invariant
		expect(onDoneCalls).toBe(1);
	});

	test("upstream error mid-stream: error event, close, onDone once", async () => {
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.error(new Error("upstream blew up"));
			},
		});
		let finished: { chars: number; error?: string } | undefined;
		const r = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_t", model: "x", routing: { port: 8901 } },
			(r) => (finished = r),
		).getReader();
		const chunks: string[] = [];
		for (;;) {
			const { value, done } = await r.read();
			if (done) break;
			chunks.push(new TextDecoder().decode(value));
		}
		// the catch branch owns the error path while the client is still
		// reading — the W278 guard must not suppress a legitimate error event
		expect(chunks.join("").includes("upstream blew up")).toBe(true);
		expect(finished?.error).toBe("upstream blew up");
	});
});

// ─── TTFB-only timeout ───
describe("openLocalStream TTFB timeout", () => {
	test("never-opening upstream fails fast with 'ttfb timeout'", async () => {
		const srv = serveStub(() => new Promise<Response>(() => {})); // headers never sent
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${srv.port}`,
			timeoutMs: 80,
		});
		srv.close();
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
		const srv = serveStub(() => new Response(body, { headers: SSE_HEADERS }));
		const opened = await openLocalStream(
			{ port: 8901, model: "m" },
			[],
			16,
			0,
			{ base: `http://127.0.0.1:${srv.port}`, timeoutMs: 50 },
		);
		expect(opened.ok).toBe(true);
		const text = await new Response(opened.ok ? opened.body : null).text();
		srv.close();
		expect(text).toContain('"content":"a"');
		expect(text).toContain('"content":"b"');
	});
});

// ─── _force_dead_port env gate (end-to-end, stub upstream) ───
describe("_force_dead_port env gate", () => {
	let stub: ReturnType<typeof serveStub>;
	let stubBase = "";
	const shims: Array<ReturnType<typeof Bun.spawn>> = [];
	const cleans: Array<() => void> = [];
	const bases: Record<string, string> = {};

	const spawnShim = async (armed: string): Promise<string> => {
		const { home, env, clean } = scratchWorld({ prefix: "w6959-" });
		cleans.push(clean);
		mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "local-llm", "prefs.json"),
			JSON.stringify({ allow_cloud: false, kev: { enabled: false } }),
		);
		const port = await freePort();
		const shim = Bun.spawn({
			cmd: [
				process.execPath,
				new URL("../bin/router-shim.ts", import.meta.url).pathname,
			],
			env: {
				...env,
				BELT_ROUTER_PORT: String(port),
				BELT_UPSTREAM_KEY: "bksk_test-scoped-fake",
				BELT_UPSTREAM_BASE: stubBase,
				BELT_RETRY_WAIT_CAP_MS: "500",
				BELT_SELFTEST: armed,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		shims.push(shim);
		const base = `http://127.0.0.1:${port}`;
		try {
			await waitUp(`${base}/health/liveliness`, {
				tries: 100,
				intervalMs: 50,
			});
		} catch {
			throw new Error("router-shim did not come up");
		}
		return base;
	};

	const post = (base: string) =>
		fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer bksk_test-scoped-fake",
			},
			body: JSON.stringify({
				model: "glm-5.3-flash",
				max_tokens: 32,
				_force_dead_port: 8901,
				messages: [{ role: "user", content: "Reply with the word OK." }],
			}),
		});

	beforeAll(async () => {
		stub = serveStub((req, body) => {
			if (req.method !== "POST") return new Response("", { status: 404 });
			const b = (body ?? {}) as { stream?: boolean };
			if (b.stream)
				return new Response(`${sseChunk("OK")}\ndata: [DONE]\n\n`, {
					headers: SSE_HEADERS,
				});
			return Response.json({
				choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
				usage: { completion_tokens: 1 },
			});
		});
		stubBase = `http://127.0.0.1:${stub.port}`;
		bases.disarmed = await spawnShim("");
		bases.armed = await spawnShim("1");
	});

	afterAll(() => {
		for (const s of shims) s.kill();
		stub.close();
		for (const c of cleans) c();
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
