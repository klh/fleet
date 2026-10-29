// test/inflight.test.ts — W1259 GET /v1/admin/inflight: the exact in-flight
// index. Unit tests drive the registry directly (lifecycle, streaming hold,
// bounded recent ring, tunnel seam); wire tests boot the real gate over a
// mock upstream and verify the owner-mandated synthetic: a request HELD
// OPEN shows a row (count 1) and decrements at settle — plus the gate
// class and the no-key-material law.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	acceptConnectSnapshot,
	beginInflight,
	clearTunnelsForTest,
	endInflight,
	inflightIndex,
	markInflight,
	resetInflightForTest,
	settleInflight,
	setInflightClockForTest,
} from "../src/gov/inflight.ts";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "buckle-test-root";
const OPENAI_USAGE = {
	id: "w1259",
	choices: [],
	usage: {
		prompt_tokens: 11,
		completion_tokens: 7,
		prompt_tokens_details: { cached_tokens: 5 },
	},
};

function begin(rid: string, overrides?: Record<string, unknown>): void {
	beginInflight({
		rid,
		trace: { traceparent: `00-${"a".repeat(32)}-1234567890abcdef-01` },
		key: "acct-1",
		lane: "w1",
		dialect: "anthropic",
		hop: { origin: "local", peer: null },
		trafficKind: "inference",
		...overrides,
	});
}

function beginServer(upstreamUrl: string): { base: string; stop(): void } {
	const dir = `/tmp/buckle-w1259-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	const cfg = `groups:
  glm-5.3-flash:
    - url: ${upstreamUrl}
      dialect: openai
`;
	writeFileSync(`${dir}.yaml`, cfg);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

interface Row {
	rid: string;
	trace_id: string;
	account: string;
	lane: string;
	dialect: string;
	model: string;
	state: string;
	upstream: { candidate_id: string } | null;
	hop: { origin: string; peer: string | null; kind: string };
	start_ms: number;
	duration_ms: number;
	status: number | null;
	ok: boolean | null;
}

async function getIndex(
	base: string,
	token: string,
): Promise<{
	status: number;
	body: {
		requests: Row[];
		tunnels: Array<Record<string, unknown>>;
		recent: Row[];
		aggregates: Record<string, unknown>;
		external: { observable: false; note: string };
	};
}> {
	const res = await fetch(`${base}/v1/admin/inflight`, {
		headers: { authorization: `Bearer ${token}` },
	});
	return { status: res.status, body: await res.json() };
}

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash", stream: false });

async function chat(base: string, token: string): Promise<Response> {
	return fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: CHAT_BODY,
	});
}

describe("W1259 registry unit", () => {
	test("lifecycle: queued → held → settled, aggregates follow", () => {
		resetInflightForTest();
		begin("r1");
		const live = inflightIndex();
		expect(live.aggregates.active).toBe(1);
		expect(live.requests[0]?.state).toBe("queued");
		expect(live.requests[0]?.hop.kind).toBe("origin");
		markInflight({
			rid: "r1",
			model: "glm-5.3-flash",
			sel: {
				head: {
					candidate_id: "127.0.0.1:4100:glm-5.3-flash",
					kind: "local",
					host: "127.0.0.1",
					port: 4100,
					model: "glm-5.3-flash",
				},
			},
		});
		const held = inflightIndex();
		expect(held.requests[0]?.state).toBe("held");
		expect(held.requests[0]?.upstream?.candidate_id).toBe(
			"127.0.0.1:4100:glm-5.3-flash",
		);
		expect(held.aggregates.by_upstream["127.0.0.1:4100:glm-5.3-flash"]).toBe(1);
		endInflight("r1", 200, true, "policy", null);
		const done = inflightIndex();
		expect(done.aggregates.active).toBe(0);
		expect(done.aggregates.recent_completed).toBe(1);
		expect(done.recent[0]?.state).toBe("settled");
		expect(done.recent[0]?.status).toBe(200);
	});

	test("streaming hold: settleInflight(streaming) holds until end", () => {
		resetInflightForTest();
		begin("r2");
		markInflight({ rid: "r2", model: "glm-5.3-flash", sel: null });
		settleInflight(
			{ rid: "r2" },
			{ status: 200, ok: true },
			{
				decision: "policy",
				streaming: true,
			},
		);
		const held = inflightIndex();
		expect(held.aggregates.active).toBe(1);
		expect(held.requests[0]?.state).toBe("streaming");
		endInflight("r2", 200, true, "policy", null);
		const done = inflightIndex();
		expect(done.aggregates.active).toBe(0);
		expect(done.recent[0]?.state).toBe("settled");
	});
	test("recent ring bounded by count and age", () => {
		resetInflightForTest();
		let t = 1_000_000;
		setInflightClockForTest(() => t);
		for (let i = 0; i < 520; i++) {
			begin(`b${i}`);
			endInflight(`b${i}`, 200, true, "policy", null);
		}
		let idx = inflightIndex();
		expect(idx.aggregates.recent_completed).toBe(512);
		expect(idx.recent[0]?.rid).toBe("b519");
		t += 6 * 60_000;
		begin("fresh");
		idx = inflightIndex();
		expect(idx.aggregates.recent_completed).toBe(0);
		expect(idx.aggregates.active).toBe(1);
	});
	test("tunnel seam: open, replace, close, by_dest + totals", () => {
		resetInflightForTest();
		clearTunnelsForTest();
		acceptConnectSnapshot({
			count: 2,
			held: [
				{
					id: "t1",
					host: "api.z.ai",
					port: 443,
					app: "codex",
					openedAt: 1000,
					bytesUp: 10,
					bytesDown: 20,
					state: "open",
				},
				{
					id: "t2",
					host: "api.anthropic.com",
					port: 443,
					app: "unknown",
					openedAt: 2000,
					bytesUp: null,
					bytesDown: null,
					state: "open",
				},
			],
		});
		begin("r3");
		const idx = inflightIndex();
		expect(idx.tunnels.length).toBe(2);
		expect(idx.tunnels[0]?.app).toBe("codex");
		expect(idx.aggregates.active).toBe(3);
		expect(idx.aggregates.active_tunnels).toBe(2);
		expect(idx.aggregates.by_dest["api.z.ai:443"]).toBe(1);
		acceptConnectSnapshot({
			count: 1,
			held: [
				{
					id: "t1",
					host: "api.z.ai",
					port: 443,
					app: "codex",
					openedAt: 1000,
					bytesUp: 15,
					bytesDown: 40,
					state: "open",
				},
			],
		});
		const after = inflightIndex();
		expect(after.tunnels.length).toBe(1);
		expect(after.tunnels[0]?.bytes_up).toBe(15);
		expect(after.aggregates.active).toBe(2);
	});
});
describe("W1259 wire: gate class + held-open synthetic", () => {
	test("bare 401, proxy-scoped 403, auditor 200", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = beginServer(upstream.url);
		try {
			const bare = await fetch(`${gate.base}/v1/admin/inflight`);
			expect(bare.status).toBe(401);
			const lane = await issueViaAdmin(gate.base, {
				name: "w1259-lane",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const forbidden = await getIndex(gate.base, lane.key);
			expect(forbidden.status).toBe(403);
			const pre = await fetch(`${gate.base}/v1/admin/inflight`, {
				method: "OPTIONS",
			});
			expect(pre.status).toBe(204);
			expect(pre.headers.get("allow")).toBe("GET, OPTIONS");
		} finally {
			gate.stop();
			upstream.close();
		}
	});
	test("held-open request shows a row (count 1) and decrements at settle", async () => {
		// Module-global registry: drop unit-test rows so counts are exact.
		resetInflightForTest();
		clearTunnelsForTest();
		let releaseUpstream: (() => void) | null = null;
		const held = new Promise<Response>((resolve) => {
			releaseUpstream = () => resolve(Response.json(OPENAI_USAGE));
		});
		// The gate runs GET /v1/models candidate discovery before the dispatch:
		// answer it immediately, hold ONLY the chat POST (a shared held Response
		// served twice throws ERR_BODY_ALREADY_USED).
		const upstream = await startMockUpstream((req) => {
			if (new URL(req.url).pathname !== "/v1/chat/completions") {
				return Response.json({
					object: "list",
					data: [{ id: "glm-5.3-flash" }],
				});
			}
			return held;
		});
		const gate = beginServer(upstream.url);
		try {
			const lane = await issueViaAdmin(gate.base, {
				name: "w1259-hold",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const auditor = await issueViaAdmin(gate.base, {
				name: "w1259-auditor",
				scopes: ["buckle:admin:READ_"],
			});
			const pending = chat(gate.base, lane.key);
			await Bun.sleep(200);
			const live = await getIndex(gate.base, auditor.key);
			expect(live.status).toBe(200);
			expect(live.body.aggregates.active_requests).toBe(1);
			const row = live.body.requests[0];
			expect(row?.state).toBe("held");
			expect(row?.account).toBe(lane.keyId);
			expect(row?.model).toBe("glm-5.3-flash");
			expect(String(row?.upstream?.candidate_id)).toContain(
				String(upstream.port),
			);
			releaseUpstream?.();
			const resp = await pending;
			expect(resp.status).toBe(200);
			const done = await getIndex(gate.base, auditor.key);
			expect(done.body.aggregates.active_requests).toBe(0);
			expect(done.body.aggregates.recent_completed).toBe(1);
			expect(done.body.recent[0]?.status).toBe(200);
			expect(done.body.recent[0]?.account).toBe(lane.keyId);
			const raw = JSON.stringify(done.body);
			expect(raw.includes(lane.key)).toBe(false);
		} finally {
			releaseUpstream?.();
			gate.stop();
			upstream.close();
		}
	});
	test("held SSE stream stays streaming until EOF, then settles", async () => {
		// Module-global registry: drop unit-test rows so counts are exact.
		resetInflightForTest();
		clearTunnelsForTest();
		let releaseStream: (() => void) | null = null;
		const released = new Promise<void>((r) => {
			releaseStream = r;
		});
		const upstream = await startMockUpstream((req) => {
			// Discovery answered immediately; the chat POST gets the held SSE body.
			if (new URL(req.url).pathname !== "/v1/chat/completions") {
				return Response.json({
					object: "list",
					data: [{ id: "glm-5.3-flash" }],
				});
			}
			return new Response(
				new ReadableStream({
					start(c) {
						// First frame flows now (a byteless hold never resolves the
						// gate's upstream fetch); the stream stays open until release.
						c.enqueue(
							new TextEncoder().encode(
								'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
							),
						);
						void released.then(() => {
							// Terminal frame before close, or the gate's stream-outcome
							// law (W129) reads the cut as a failed stream.
							c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
							c.close();
						});
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const gate = beginServer(upstream.url);
		try {
			const lane = await issueViaAdmin(gate.base, {
				name: "w1259-sse",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const auditor = await issueViaAdmin(gate.base, {
				name: "w1259-sse-auditor",
				scopes: ["buckle:admin:READ_"],
			});
			const sse = JSON.stringify({ model: "glm-5.3-flash", stream: true });
			const pending = fetch(`${gate.base}/v1/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${lane.key}` },
				body: sse,
			});
			await Bun.sleep(250);
			const live = await getIndex(gate.base, auditor.key);
			expect(live.status).toBe(200);
			expect(live.body.aggregates.active_requests).toBe(1);
			expect(live.body.requests[0]?.state).toBe("streaming");
			expect(live.body.requests[0]?.hop.kind).toBe("origin");
			releaseStream?.();
			const resp = await pending;
			expect(resp.status).toBe(200);
			await resp.text();
			const done = await getIndex(gate.base, auditor.key);
			expect(done.body.aggregates.active_requests).toBe(0);
			expect(done.body.recent[0]?.state).toBe("settled");
		} finally {
			releaseStream?.();
			gate.stop();
			upstream.close();
		}
	});
});
