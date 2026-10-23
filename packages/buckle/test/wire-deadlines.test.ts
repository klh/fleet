// test/wire-deadlines.test.ts — W450: slow/quiet streams survive their
// configured deadlines; deadline breaches abort with a timeout RouterError.
import { describe, expect, test } from "bun:test";
import {
	defaultFetch,
	HubConnectError,
	type StreamGuards,
	tcpConnects,
} from "../src/wire.ts";
import { startMockUpstream } from "./mock.ts";
import type { UpstreamRequest } from "../src/router.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const dep = (url: string) => ({ group: "g", url, dialect: "openai" as const });
const req = (stream: boolean): UpstreamRequest =>
	({
		group: "g",
		dialect: "openai",
		path: "/v1/chat/completions",
		body: { model: "m", messages: [], stream },
		key: "",
	}) as UpstreamRequest;

/** Mock SSE body: silent delay, then chunks with gaps. Server-side writes
 *  race the client teardown at a deadline — swallow the dead-writer noise. */
const sseResp = (firstMs: number, chunks: number, gapMs: number): Response => {
	const body = new ReadableStream({
		start: async (c) => {
			await Bun.sleep(firstMs);
			try {
				for (let i = 0; i < chunks; i++) {
					c.enqueue(enc(`data: {"x":${String(i)}}\n\n`));
					await Bun.sleep(gapMs);
					if (i === chunks - 1) c.close();
				}
			} catch {
				// the reader went away at a deadline — nothing to write to
			}
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
};

/** Mock SSE body that emits one chunk and never closes (the hung upstream). */
const stallsForever = (): Response =>
	new Response(
		new ReadableStream({
			start: (c) => {
				c.enqueue(enc("data: 1\n\n"));
			},
			cancel: () => {}, // the deadline tore the reader down
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);

describe("W450 stream deadlines", () => {
	test("explicit LiteLLM engine gets bounded non-stream timeout and no stream wall-clock cap", async () => {
		const seen: Array<{ timeout: string | null; retries: string | null }> = [];
		const up = await startMockUpstream(async (request) => {
			seen.push({
				timeout: request.headers.get("x-litellm-timeout"),
				retries: request.headers.get("x-litellm-num-retries"),
			});
			return Response.json({ ok: true });
		});
		try {
			const litellm = {
				...dep(up.url),
				adapter_config: { proxy_kind: "litellm" },
			};
			await defaultFetch(litellm, req(false), 30_000);
			await defaultFetch(litellm, req(true), 30_000, {
				idleMs: 60_000,
				totalMs: 900_000,
			});
			await defaultFetch(dep(up.url), req(false), 30_000);
			expect(seen).toEqual([
				{ timeout: "30", retries: "0" },
				{ timeout: null, retries: "0" },
				{ timeout: null, retries: null },
			]);
		} finally {
			up.close();
		}
	});
	test("dead Buckle hub fails at connect without spending the model deadline", async () => {
		const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const url = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);
		const started = Date.now();
		const error = await defaultFetch(
			{ ...dep(url), buckle: true },
			req(false),
			120_000,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HubConnectError);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("connected Buckle hub may spend time on inference after connect", async () => {
		const up = await startMockUpstream(async () => {
			await Bun.sleep(150);
			return Response.json({ ok: true });
		});
		const result = await defaultFetch(
			{ ...dep(up.url), buckle: true },
			req(false),
			1_000,
		);
		expect(result.status).toBe(200);
		up.close();
	});

	test("a TCP-open but HTTP-unresponsive Buckle peer is ejected before inference", async () => {
		const up = Bun.serve({
			port: 0,
			fetch: async (request) => {
				if (new URL(request.url).pathname === "/status") {
					await Bun.sleep(5_000);
					return Response.json({ ok: true });
				}
				return Response.json({ ok: true });
			},
		});
		const started = Date.now();
		const error = await defaultFetch(
			{ ...dep(`http://127.0.0.1:${up.port}`), buckle: true },
			req(false),
			120_000,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HubConnectError);
		expect(Date.now() - started).toBeLessThan(4_000);
		up.stop(true);
	});
	test("slow first token survives; healthy drips reset the idle guard", async () => {
		const up = await startMockUpstream(() => sseResp(80, 4, 30));
		// TTFB window 1000ms ≫ the 80ms silence; idle 50ms ≫ the 30ms gaps
		const g: StreamGuards = { idleMs: 50, totalMs: 60_000 };
		const r = await defaultFetch(dep(up.url), req(true), 1000, g);
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(text).toContain("x");
		up.close();
	});

	test("silent mid-stream dies at the idle deadline", async () => {
		const up = await startMockUpstream(() => stallsForever());
		const t0 = Date.now();
		const r = await defaultFetch(dep(up.url), req(true), 5000, {
			idleMs: 120,
			totalMs: 60_000,
		});
		expect(r.status).toBe(200);
		const err = await r.text().catch((e: Error) => e);
		const dt = Date.now() - t0;
		expect(dt).toBeGreaterThanOrEqual(100); // idle window, not instant
		expect(dt).toBeLessThan(3000); // far under the total window
		expect(String(err)).toContain("deadline");
		up.close();
	});

	test("total deadline fires despite a healthy drip (idle keeps resetting)", async () => {
		const up = await startMockUpstream(() => sseResp(5, 99, 30));
		const t0 = Date.now();
		const r = await defaultFetch(dep(up.url), req(true), 5000, {
			idleMs: 1000,
			totalMs: 200,
		});
		expect(r.status).toBe(200);
		const err = await r.text().catch((e: unknown) => e);
		const dt = Date.now() - t0;
		expect(dt).toBeGreaterThanOrEqual(150);
		expect(dt).toBeLessThan(2500);
		expect(String(err)).toContain("total");
		up.close();
	});

	test("non-streaming: late upstream stays bounded by the exchange cap", async () => {
		// Bun.serve defers headers until the first body byte, so a late
		// non-streaming body IS a late TTFB — the fetch rejects at the cap
		// (the pre-W450 AbortSignal.timeout behavior, preserved).
		const up = await startMockUpstream(async () => {
			await Bun.sleep(300);
			return Response.json({ ok: true });
		});
		const t0 = Date.now();
		const out = await defaultFetch(dep(up.url), req(false), 100).then(
			() => "resolved",
			(e: Error) => e.name,
		);
		const dt = Date.now() - t0;
		expect(out).toBe("TimeoutError");
		expect(dt).toBeGreaterThanOrEqual(100);
		up.close();
	});

	test("non-streaming healthy exchange survives its cap", async () => {
		const up = await startMockUpstream(() => sseResp(40, 1, 1));
		const r = await defaultFetch(dep(up.url), req(false), 5000);
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("x");
		up.close();
	});

	test("W1096: plain row dead origin fails at connect, bounded, never at the model deadline", async () => {
		const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const url = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);
		const started = Date.now();
		const error = await defaultFetch(
			dep(url),
			req(false),
			120_000,
			undefined,
			1_000,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HubConnectError);
		expect(Date.now() - started).toBeLessThan(4_000);
	});

	test("W1096: blackholed origin resolves at the connect bound, not the 120s model deadline", async () => {
		// 192.0.2.1 is TEST-NET-1: routable nowhere — the blackhole fixture
		const started = Date.now();
		const error = await defaultFetch(
			dep("http://192.0.2.1:4301"),
			req(false),
			120_000,
			undefined,
			300,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HubConnectError);
		const dt = Date.now() - started;
		expect(dt).toBeGreaterThanOrEqual(250);
		expect(dt).toBeLessThan(4_000);
	});

	test("W1096: slow inference on a live origin is never cut off by the connect bound", async () => {
		const up = await startMockUpstream(async () => {
			await Bun.sleep(700); // ≫ the 250ms connect bound, ≪ the 5s model deadline
			return Response.json({ ok: true });
		});
		const r = await defaultFetch(
			dep(up.url),
			req(false),
			5_000,
			undefined,
			250,
		);
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("ok");
		up.close();
	});

	test("W1096: tcpConnects proves a live TCP origin answers and a dead one does not", async () => {
		const up = await startMockUpstream(() => Response.json({ ok: true }));
		expect(await tcpConnects(up.url, 1_000)).toBe(true);
		expect(await tcpConnects("http://192.0.2.1:4301", 200)).toBe(false);
		up.close();
	});
});
