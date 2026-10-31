// W2260: stream receipt correlation + activity classification. Co-situated
// proof for src/stream-correlation.ts and the proxy-stream receipt wiring:
//   hopCorrelationOf  — bounded id extraction from upstream headers
//   streamActivityOf  — semantic | ping_only | none
//   SseSniffer.framesSeen — pings never count as semantic frames
// and the app-level receipts a truncated/ping-only stream banks.
import {
	poolOfUrl as kitPoolOfUrl,
	sseEnc as enc,
	sseHeaders,
} from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import { SseSniffer } from "../src/sse.ts";
import {
	hopCorrelationOf,
	streamActivityOf,
} from "../src/stream-correlation.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const poolOf = (url: string) => kitPoolOfUrl(url);

const receiptOf = (audit: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(audit.stream_receipt ?? "{}")) as Record<string, unknown>;

test.describe("@api", () => {
	test("hopCorrelationOf extracts bounded ids; junk stays null", () => {
		const h = new Headers({
			"x-request-id": "req-123",
			"x-litellm-call-id": "call-abc",
		});
		const corr = hopCorrelationOf(h);
		expect(corr.upstreamRequestId).toBe("req-123");
		expect(corr.litellmCallId).toBe("call-abc");
		const peer = new Headers({
			"x-klh-upstream-request-id": "peer-9",
			"x-request-id": "req-123",
		});
		expect(hopCorrelationOf(peer).upstreamRequestId).toBe("peer-9");
		expect(hopCorrelationOf(new Headers()).upstreamRequestId).toBeNull();
		expect(
			hopCorrelationOf(new Headers({ "x-request-id": "bad id!" }))
				.upstreamRequestId,
		).toBeNull();
	});

	test("streamActivityOf: semantic | ping_only | none", () => {
		expect(streamActivityOf(3, 0)).toBe("semantic");
		expect(streamActivityOf(0, 7)).toBe("ping_only");
		expect(streamActivityOf(0, 0)).toBe("none");
	});

	test("SseSniffer.framesSeen: pings never count as semantic frames", () => {
		const s = new SseSniffer("anthropic");
		s.push(
			'event: ping\ndata: {"type":"ping"}\n\n' +
				'data: {"type":"ping"}\n\n' +
				": comment keepalive\n\n" +
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
		);
		expect(s.framesSeen()).toBe(1);
	});

	test("ping-only stream EOFs → activity ping_only, retry_eligible", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'event: ping\ndata: {"type":"ping"}\n\n' +
						'data: {"type":"ping"}\n\n',
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
			expect(audit.err).toBe("stream_truncated");
			const receipt = receiptOf(audit);
			expect(receipt.activity).toBe("ping_only");
			expect(receipt.retry_eligible).toBe(true);
		} finally {
			upstream.close();
		}
	});

	test("completed semantic turn banks correlation ids", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					enc.encode(
						'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
							'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n' +
							'event: message_stop\ndata: {"type":"message_stop"}\n\n',
					),
					{
						headers: {
							...sseHeaders,
							"x-request-id": "req-123",
							"x-litellm-call-id": "call-abc",
						},
					},
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
			const receipt = receiptOf(audit);
			expect(receipt.activity).toBe("semantic");
			expect(receipt.upstream_request_id).toBe("req-123");
			expect(receipt.litellm_call_id).toBe("call-abc");
			expect(receipt.retry_eligible).toBeFalsy();
		} finally {
			upstream.close();
		}
	});

	test("semantic stream truncated mid-turn → no retry_eligible", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}\n\n',
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
			expect(audit.err).toBe("stream_truncated");
			const receipt = receiptOf(audit);
			expect(receipt.activity).toBe("semantic");
			expect(receipt.retry_eligible).toBe(false);
		} finally {
			upstream.close();
		}
	});
});

