// test/w1106-stream-receipts.test.ts — W1106 focused gates: typed terminal
// stream receipts (downstream_cancel as terminal NON-success, upstream_
// deadline on a silent upstream) + the streamResponse MIME contract
// (SSE forced on classified streams only; JSON/client-error keep their
// own MIME — the shared SSE_HEADERS helper stays untouched).
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const poolOf = (url: string): UpstreamPool => ({
	groups: () => ["claude-sonnet-5"],
	deployments: (group) => [{ group, url, dialect: "anthropic" as const }],
});

const sseHeaders = { "content-type": "text/event-stream" };
const enc = new TextEncoder();

/** auditRows() returns the raw row — the receipt column is stored JSON. */
const receiptOf = (audit: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(audit.stream_receipt ?? "{}")) as Record<string, unknown>;

describe("W1106 stream receipts", () => {
	test("client abort → terminal downstream_cancel, ok:0, decision errored", async () => {
		// one chunk, then silent — the abort must NOT bank as upstream_eof
		const upstream = await startMockUpstream(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(
								enc.encode(
									'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
								),
							);
						},
					}),
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const ac = new AbortController();
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
					signal: ac.signal,
				}),
			);
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			expect(reader).toBeDefined();
			await reader?.read(); // first chunk delivered
			await ac.abort();
			await Bun.sleep(50); // pipes reject + finish() banks the receipt
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.decision).toBe("errored");
			expect(audit.error_code).toBe("downstream_cancel");
			expect(audit.err).toBe("downstream_cancel");
			const receipt = receiptOf(audit);
			expect(receipt.terminal).toBe("downstream_cancel");
			expect(Number(receipt?.bytes_in)).toBeGreaterThan(0);
			expect(Number(receipt?.chunks_in)).toBeGreaterThanOrEqual(1);
			expect(receipt?.last_chunk_ms).not.toBeNull();
		} finally {
			upstream.close();
		}
	});

	test("silent mid-stream upstream → terminal upstream_deadline (typed)", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(
								enc.encode(
									'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
								),
							);
						},
					}),
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url), {
				policy: { num_retries: 1, stream_idle_timeout_s: 0.1 },
			});
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			expect(res.status).toBe(200);
			const text = await res.text(); // error event terminates the body
			expect(text).toContain("error");
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).toBe("stream_failed");
			expect(audit.err).toBe("stream_failed:timeout");
			const receipt = receiptOf(audit);
			expect(receipt.terminal).toBe("upstream_deadline");
		} finally {
			upstream.close();
		}
	});
});

describe("W1106 terminal-aware completion (#55419/#55420)", () => {
	test("upstream EOF without message_stop → stream_truncated, ok:0", async () => {
		// message_start then EOF — NO message_stop: a truncated turn, never
		// a completed success even though the pipe drained cleanly.
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			expect(res.status).toBe(200);
			await res.text();
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.decision).toBe("errored");
			expect(audit.error_code).toBe("stream_truncated");
			expect(audit.err).toBe("stream_truncated");
			expect(receiptOf(audit).terminal).toBe("upstream_eof_truncated");
		} finally {
			upstream.close();
		}
	});

	test("full turn WITH message_stop → ok:1, terminal upstream_eof", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
						'event: message_stop\ndata: {"type":"message_stop"}\n\n',
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			expect(res.status).toBe(200);
			await res.text();
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(1);
			expect(audit.error_code).toBeNull();
			expect(receiptOf(audit).terminal).toBe("upstream_eof");
		} finally {
			upstream.close();
		}
	});
});

describe("W1106 MIME contract (#55129/#55126)", () => {
	test("non-stream JSON keeps application/json (never event-stream)", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "msg_json", usage: { input_tokens: 1 } }),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
				}),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type") ?? "").toContain(
				"application/json",
			);
			expect(res.headers.get("content-type") ?? "").not.toContain(
				"event-stream",
			);
		} finally {
			upstream.close();
		}
	});

	test("upstream client-error keeps its own MIME (JSON error stays JSON)", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(JSON.stringify({ error: { type: "overloaded_error" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			expect(res.status).toBe(429);
			expect(res.headers.get("content-type") ?? "").toContain(
				"application/json",
			);
		} finally {
			upstream.close();
		}
	});

	test("classified stream forces text/event-stream even when upstream mislabels", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response('data: {"type":"message_stop"}\n\n', {
					headers: { "content-type": "text/plain" },
				}),
		);
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
				}),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type") ?? "").toContain(
				"text/event-stream",
			);
		} finally {
			upstream.close();
		}
	});
});
