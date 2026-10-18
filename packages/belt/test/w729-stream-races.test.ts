// W729 — verify-or-refute the opus-review stream-race claims against
// f2f5602a (W278 cancel guard + W695.9 TTFB timer). Stub servers only —
// never the live :890x fleet.
import { afterAll, describe, expect, test } from "bun:test";
import { anthropicSseFromOpenAi, openLocalStream } from "../bin/router-core.ts";

const enc = new TextEncoder();
const sseChunk = (text: string) =>
	`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const SSE_HEADERS = { "content-type": "text/event-stream" };

// ─── claim 1: relay cancel guard (anthropicSseFromOpenAi) ───
describe("W729 relay cancel race", () => {
	test("cancel racing a fulfilled read: post-resume chunk dropped, no throw, done once", async () => {
		let upstreamCancelled = false;
		let upstreamCtrl: ReadableStreamDefaultController<Uint8Array>;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				upstreamCtrl = c;
				c.enqueue(enc.encode(sseChunk("a")));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		let doneCalls = 0;
		let finished: { chars: number; error?: string } | undefined;
		const reader = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_t", model: "x", routing: { port: 8901 } },
			(r) => {
				doneCalls++;
				finished = r;
			},
		).getReader();
		await reader.read(); // head + delta "a"
		// one consumer turn: enqueue (fulfils the pump's pending read → its
		// resumption lands on the microtask queue) THEN cancel (the cancel
		// algorithm runs synchronously → clientGone=true first). The pump
		// resumes with the chunk in hand — the claimed interleaving — and the
		// guard must drop it, not enqueue onto the closed stream.
		upstreamCtrl.enqueue(enc.encode(sseChunk("b")));
		await reader.cancel("bye");
		await Bun.sleep(20);
		expect(upstreamCancelled).toBe(true);
		expect(doneCalls).toBe(1);
		expect(finished?.error).toBe("client cancelled");
	});
});

// ─── claim 2: TTFB timer vs late body — bounded, no leak ───
describe("W729 TTFB timer vs late body", () => {
	const servers: Array<ReturnType<typeof Bun.serve>> = [];
	afterAll(() => {
		for (const s of servers) s.stop(true);
	});

	test("headers past the cap: fail-fast 'ttfb timeout', bounded wall time", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: async () => {
				await Bun.sleep(300);
				return new Response(sseChunk("late"), { headers: SSE_HEADERS });
			},
		});
		servers.push(srv);
		const t0 = Date.now();
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${srv.port}`,
			timeoutMs: 80,
		});
		const wall = Date.now() - t0;
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.error).toContain("ttfb timeout");
		expect(wall).toBeLessThan(2000);
	});

	test("post-header non-SSE stall: bounded drain (W732), no hang", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(enc.encode("partial")); // headers in, body stalls
						},
					}),
					{ headers: { "content-type": "text/plain" } },
				),
		});
		servers.push(srv);
		const t0 = Date.now();
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${srv.port}`,
			timeoutMs: 100,
		});
		const wall = Date.now() - t0;
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.error).toContain("200 text/plain");
		expect(wall).toBeLessThan(2000);
	});
});
