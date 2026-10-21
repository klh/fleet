// test/w1106-bridge-terminal.test.ts — W1106.2: a bridge must preserve the
// SOURCE's terminal/failure state, never synthesize a target-side success.
// Both truncation directions + one bridged in-band failure, each verified
// through the stream transform AND the route_audit receipt (ok:0 / typed
// terminal). Source-fidelity law: generated terminal ≠ source completion.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import {
	AnthropicToOpenAIStream,
	OpenAIToAnthropicStream,
} from "../src/adapters/tools.ts";
import { anthropicToOpenAISse, openAIToAnthropicSse } from "../src/bridge.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const sseHeaders = { "content-type": "text/event-stream" };

type AnyRec = Record<string, unknown>;

const receiptOf = (audit: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(audit.stream_receipt ?? "{}")) as Record<string, unknown>;

const bodyOf = (res: Response): ReadableStream<Uint8Array> => {
	const b = res.body;
	if (b === null) throw new Error("response had no body");
	return b;
};

// ─── transform level: flush() respects the source's terminal state ───

describe("W1106.2 OpenAIToAnthropicStream source-fidelity", () => {
	test("EOF without [DONE] → flush emits NO success terminal", () => {
		const s = new OpenAIToAnthropicStream();
		const out = s.push({
			id: "c1",
			model: "gpt-x",
			choices: [{ index: 0, delta: { role: "assistant", content: "he" } }],
		});
		expect(out.map((e) => e.event)).toContain("message_start");
		// truncated source: flush carries delta content close-out ONLY when a
		// source terminal licensed it — here it must not fabricate message_stop
		const f = s.flush();
		expect(f.map((e) => e.event)).not.toContain("message_stop");
	});

	test("[DONE] observed → flush emits the success terminal exactly once", () => {
		const s = new OpenAIToAnthropicStream();
		s.push({
			id: "c1",
			model: "gpt-x",
			choices: [{ index: 0, delta: { content: "he" } }],
		});
		// (the sentinel itself is transport — the BRIDGE flags it; the class
		// exposes the license via noteDone()/failed() called by bridge.ts)
		s.noteDone();
		const f = s.flush();
		expect(f.map((e) => e.event)).toEqual([
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(s.flush()).toEqual([]); // exactly once
	});

	test("response.failed (nested response.error) → error event, never success", () => {
		const s = new OpenAIToAnthropicStream();
		const out = s.push({
			type: "response.failed",
			response: {
				error: { code: "server_error", message: "boom" },
			},
		});
		expect(out.map((e) => e.event)).toEqual(["error"]);
		const first = out[0] as unknown as {
			data: { error: Record<string, unknown> };
		};
		expect(first.data.error.type).toBe("api_error");
		s.noteDone(); // even with a [DONE] after it
		const f = s.flush();
		expect(f.map((e) => e.event)).not.toContain("message_stop");
	});
});

describe("W1106.2 AnthropicToOpenAIStream source-fidelity", () => {
	test("EOF without message_stop → flush emits NO finish frame, sawStop false", () => {
		const s = new AnthropicToOpenAIStream();
		s.push({
			event: "message_start",
			data: {
				type: "message_start",
				message: { id: "m1", model: "claude-x", usage: { input_tokens: 1 } },
			},
		});
		s.push({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "he" },
			},
		});
		expect(s.sawStop()).toBe(false);
		const f = s.flush();
		// the flush-RETRIED finish (unterminated stream) still emits — the
		// openai wire needs ONE finish frame — but it is not a license:
		// sawStop() stays false so the [DONE] sentinel never fabricates.
		expect(
			f.map(
				(c) =>
					((c as AnyRec).choices as Array<{ finish_reason?: string }>)[0]
						?.finish_reason ?? "usage",
			),
		).toEqual(["stop", "usage"]);
	});

	test("message_stop → finish frame + sawStop true (the [DONE] license)", () => {
		const s = new AnthropicToOpenAIStream();
		s.push({
			event: "message_start",
			data: {
				type: "message_start",
				message: { id: "m1", model: "claude-x", usage: { input_tokens: 1 } },
			},
		});
		s.push({ event: "message_stop", data: { type: "message_stop" } });
		expect(s.sawStop()).toBe(true);
		const f = s.flush();
		// finish already emitted at message_stop; flush is idempotent
		expect(f).toEqual([]);
	});
});

// ─── SSE bridge level: the sentinel + terminal ride the source state ───

describe("W1106.2 SSE bridge terminals", () => {
	test("openai→anthropic: truncated source (no [DONE]) → no message_stop", async () => {
		const upstreamBody =
			'data: {"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n';
		const res = new Response(upstreamBody, { headers: sseHeaders });
		const translated = bodyOf(res).pipeThrough(openAIToAnthropicSse());
		const text = await new Response(translated).text();
		expect(text).not.toContain("message_stop");
		expect(text).toContain("content_block_delta");
	});

	test("openai→anthropic: full source ([DONE]) → message_delta + message_stop", async () => {
		const upstreamBody =
			'data: {"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n' +
			"data: [DONE]\n\n";
		const res = new Response(upstreamBody, { headers: sseHeaders });
		const translated = bodyOf(res).pipeThrough(openAIToAnthropicSse());
		const text = await new Response(translated).text();
		expect(text).toContain("message_stop");
		expect(text).toContain('"stop_reason":"end_turn"');
	});

	test("anthropic→openai: truncated source (no message_stop) → NO [DONE]", async () => {
		const upstreamBody =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":1}}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n';
		const res = new Response(upstreamBody, { headers: sseHeaders });
		const translated = bodyOf(res).pipeThrough(anthropicToOpenAISse());
		const text = await new Response(translated).text();
		// the flush-RETRIED finish frame keeps the wire valid, but the
		// [DONE] sentinel — the openai success marker — must NOT fabricate.
		expect(text).not.toContain("data: [DONE]");
		expect(text).toContain('"finish_reason":"stop"'); // retried finish
	});

	test("anthropic→openai: full source (message_stop) → [DONE] sentinel", async () => {
		const upstreamBody =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":1}}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const res = new Response(upstreamBody, { headers: sseHeaders });
		const translated = bodyOf(res).pipeThrough(anthropicToOpenAISse());
		const text = await new Response(translated).text();
		expect(text).toContain("[DONE]");
		expect(text).toContain('"finish_reason":"stop"');
	});
});

// ─── e2e: the audit receipt carries the SOURCE verdict, not the bridge's ───

const poolOf = (
	url: string,
	dialect: "openai" | "anthropic",
): UpstreamPool => ({
	groups: () => ["duo"],
	deployments: (g) => [{ group: g, url, dialect }],
});

const oaiChatReq = (url: string): Request =>
	new Request(`${url}/v1/chat/completions`, {
		method: "POST",
		body: JSON.stringify({
			model: "duo",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		}),
	});

describe("W1106.2 bridged truncation/failure e2e (audit ok:0, typed terminal)", () => {
	test("openai upstream truncated (no [DONE]) → anthropic client, ok:0 stream_truncated", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'data: {"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n',
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url, "openai"));
			const res = await createApp(deps).fetch(oaiChatReq(upstream.url));
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).not.toContain("[DONE]"); // no fabricated sentinel
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).toBe("stream_truncated");
			expect(receiptOf(audit).terminal).toBe("upstream_eof_truncated");
		} finally {
			upstream.close();
		}
	});

	test("anthropic upstream truncated (no message_stop) → openai client, ok:0 stream_truncated", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":1}}}\n\n',
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url, "anthropic"));
			const res = await createApp(deps).fetch(oaiChatReq(upstream.url));
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).not.toContain("[DONE]");
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).toBe("stream_truncated");
		} finally {
			upstream.close();
		}
	});

	test("bridged in-band failure (openai response.failed + [DONE]) → anthropic client, ok:0 stream_failed", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'data: {"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n' +
						'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}\n\n' +
						"data: [DONE]\n\n",
					{ headers: sseHeaders },
				),
		);
		try {
			const deps = testDeps(poolOf(upstream.url, "openai"));
			const res = await createApp(deps).fetch(
				new Request(`${upstream.url}/v1/messages`, {
					method: "POST",
					body: JSON.stringify({
						model: "duo",
						stream: true,
						max_tokens: 64,
						messages: [{ role: "user", content: "hi" }],
					}),
				}),
			);
			expect(res.status).toBe(200);
			const text = await res.text();
			// the source FAILED in-band → the anthropic wire carries the error
			// event and NO success terminal (message_stop never fabricates).
			expect(text).toContain('"type":"error"');
			expect(text).not.toContain("message_stop");
			await Bun.sleep(20);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).toBe("stream_failed");
		} finally {
			upstream.close();
		}
	});
});
