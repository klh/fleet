// test/wire-deadlines.test.ts — W450: slow/quiet streams survive their
// configured deadlines; deadline breaches abort with a timeout RouterError.
import { describe, expect, test } from "bun:test";
import { defaultFetch, type StreamGuards } from "../src/wire.ts";
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
const sseResp = (
	firstMs: number,
	chunks: number,
	gapMs: number,
): Response => {
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
});
