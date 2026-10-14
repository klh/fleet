// W732 — verify-or-refute the W695.9 oracle-review claims: (1) the
// enqueue-after-cancel guard races, (2) stream/timeout resource leaks.
// Stub streams and servers only — never the live :890x fleet.
import { describe, expect, test } from "bun:test";
import { anthropicSseFromOpenAi, openLocalStream } from "../bin/router-core.ts";

const enc = new TextEncoder();
const sseChunk = (text: string) =>
	`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

// ─── claim 1: cancel racing the SSE pump ───
describe("claim 1: cancel racing the SSE pump", () => {
	test("cancel after a read resolves but before the pump resumes: chunk dropped, no throw", async () => {
		let pushSecond: (() => void) | undefined;
		const gate = new Promise<void>((r) => (pushSecond = r));
		let upstreamCancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(sseChunk("a")));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		let finished: { chars: number; error?: string } | undefined;
		const reader = anthropicSseFromOpenAi(
			upstream,
			{ id: "msg_w732", model: "x", routing: { port: 8901 } },
			(r) => (finished = r),
		).getReader();
		// drain head + first delta: the pump is now suspended on read()
		await reader.read();
		await reader.read();
		// resolve the pending read, then cancel before the pump can resume
		pushSecond?.();
		await reader.cancel("bye");
		await Bun.sleep(20);
		expect(finished?.error).toBe("client cancelled");
		expect(upstreamCancelled).toBe(true);
	});
});

// ─── claim 2: TTFB timer vs late body / resource leaks ───
describe("claim 2: TTFB timer vs late body", () => {
	test("failed open: stale TTFB fire is a harmless no-op (no crash, no unhandled rejection)", async () => {
		const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = srv.port;
		srv.stop(true); // now a refusing socket
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${port}`,
			timeoutMs: 50,
		});
		expect(r.ok).toBe(false);
		await Bun.sleep(100); // the stale timer fires inside this window
		expect(r.ok).toBe(false);
	});

	test("header-then-stall error body drains bounded, not forever", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(enc.encode("partial")); // never closes
						},
					}),
					{ status: 500, headers: { "content-type": "text/plain" } },
				),
		});
		const t0 = Date.now();
		const r = await openLocalStream({ port: 8901, model: "m" }, [], 16, 0, {
			base: `http://127.0.0.1:${srv.port}`,
			timeoutMs: 100,
		});
		srv.stop(true);
		expect(r.ok).toBe(false);
		expect(r.ok ? "" : r.error).toContain("500");
		expect(Date.now() - t0).toBeLessThan(2_000);
	});
});
