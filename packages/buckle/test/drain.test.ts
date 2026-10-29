// test/drain.test.ts — W1156: the deployment-drain seam end to end. The
// arming surface (POST /v1/admin/drain, root/admin scope) flips the
// process-global drain; every in-flight SSE client receives the dialect
// gateway_restarting terminal over the real stream plumbing, and an
// unexpected shutdown (no arming) keeps its real cause. The captured
// transform controller is terminated (Bun has no
// TransformStreamDefaultController.close — probe 2026-10-22).
import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp } from "../src/handlers.ts";
import {
	beginDrain,
	drainInfo,
	drainTerminalFrame,
	resetDrainForTest,
} from "../src/drain.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const ROOT = "buckle-test-root";
const sseHeaders = { "content-type": "text/event-stream" };
const enc = new TextEncoder();
const FIRST_FRAME =
	'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';

// The drain is process-global module state; a leaked armed backstop would
// force-exit the test run at its deadline.
afterEach(() => resetDrainForTest());

const poolOf = (
	url: string,
	dialect: "anthropic" | "openai" = "anthropic",
): UpstreamPool => ({
	groups: () => ["claude-sonnet-5"],
	deployments: (group) => [{ group, url, dialect }],
});

/** Real Bun.serve gate on a scratch port (the arming-surface harness). */
async function startGate(upstreamUrl: string): Promise<{
	base: string;
	stop(): void;
}> {
	const dir = `/tmp/buckle-drain-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	await Bun.write(
		`${dir}.json`,
		JSON.stringify({
			groups: {
				"glm-5.3-flash": [{ url: upstreamUrl, dialect: "anthropic" }],
			},
		}),
	);
	// Hermetic policy: `{}` is a valid minimal GatewayPolicy. Without an
	// explicit path the server resolves the LIVE machine routing-policy
	// (operator-edited mid-session) and pool-policy churn breaks the lane.
	await Bun.write(`${dir}.policy.json`, "{}");
	const server = startServer({
		port: 0,
		policyPath: `${dir}.policy.json`,
		upstreamsPath: `${dir}.json`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** Held upstream body: the first frame goes out, then the stream holds
 *  until the test releases it (fresh per request — a mid-drain second
 *  request must hold too). */
const startHeldUpstream = async () => {
	const releases: Array<() => void> = [];
	const upstream = await startMockUpstream(() => {
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(FIRST_FRAME));
				releases.push(() => {
					try {
						c.close();
					} catch {
						// already closed by the drain/teardown
					}
				});
			},
		});
		return new Response(body, { headers: sseHeaders });
	});
	return { upstream, releases };
};

/** W1156.1 held upstream variant: the first frame, then a typed in-band
 *  overloaded_error, then the stream HOLDS (no protocol terminal) until
 *  the test releases it. */
const startHeldErrorUpstream = async () => {
	const releases: Array<() => void> = [];
	const upstream = await startMockUpstream(() => {
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(FIRST_FRAME));
				c.enqueue(
					enc.encode(
						'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"original provider failure"}}\n\n',
					),
				);
				releases.push(() => {
					try {
						c.close();
					} catch {
						// already closed by the drain/teardown
					}
				});
			},
		});
		return new Response(body, { headers: sseHeaders });
	});
	return { upstream, releases };
};

/** Read the streamed body, accumulating text; stop as soon as `until`
 *  matches so the test can act mid-stream. */
async function readStream(
	res: Response,
	until?: (acc: string) => boolean,
): Promise<string> {
	const reader = res.body?.getReader();
	expect(reader).toBeDefined();
	const dec = new TextDecoder();
	let acc = "";
	for (;;) {
		const chunk = (await reader?.read()) as {
			done: boolean;
			value?: Uint8Array;
		};
		if (chunk.done) break;
		acc += dec.decode(chunk.value, { stream: true });
		if (until?.(acc)) break;
	}
	reader?.releaseLock();
	return acc;
}

/** auditRows() stores the receipt column as JSON. */
const receiptOf = (audit: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(audit.stream_receipt ?? "{}")) as Record<string, unknown>;

describe("W1156 drain terminal frames", () => {
	test("anthropic: event:error envelope with code + request_id", () => {
		const frame = drainTerminalFrame("anthropic", "rid-1");
		expect(frame.startsWith("event: error\ndata: ")).toBe(true);
		expect(frame.endsWith("\n\n")).toBe(true);
		const envelope = JSON.parse(frame.slice("event: error\ndata: ".length)) as {
			error: { type: string; code: string };
			request_id: string;
		};
		expect(envelope.error.type).toBe("api_error");
		expect(envelope.error.code).toBe("gateway_restarting");
		expect(envelope.request_id).toBe("rid-1");
	});

	test("openai: bare data frame with server_error code + request_id", () => {
		const frame = drainTerminalFrame("openai", "rid-2");
		expect(frame.startsWith("data: ")).toBe(true);
		const envelope = JSON.parse(frame.slice("data: ".length)) as {
			error: { type: string; code: string };
			request_id: string;
		};
		expect(envelope.error.type).toBe("server_error");
		expect(envelope.error.code).toBe("gateway_restarting");
		expect(envelope.request_id).toBe("rid-2");
	});
});

describe("W1156 beginDrain", () => {
	test("first intent wins; the second signal is a null no-op", () => {
		const first = beginDrain("deployment:first", 60_000);
		expect(first?.reason).toBe("deployment:first");
		expect(first?.deadlineMs).toBeGreaterThan(first?.sinceMs ?? 0);
		expect(drainInfo()?.reason).toBe("deployment:first");
		expect(beginDrain("deployment:second", 1000)).toBeNull();
		expect(drainInfo()?.reason).toBe("deployment:first");
	});
});

describe("W1156 arming surface (POST /v1/admin/drain)", () => {
	test("401 anonymous; 400 on a missing reason; no drain armed", async () => {
		const { upstream } = await startHeldUpstream();
		const gate = await startGate(upstream.url);
		try {
			const anon = await fetch(`${gate.base}/v1/admin/drain`, {
				method: "POST",
				body: JSON.stringify({ reason: "test:anon" }),
			});
			expect(anon.status).toBe(401);
			const noReason = await fetch(`${gate.base}/v1/admin/drain`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({ grace_ms: 100 }),
			});
			expect(noReason.status).toBe(400);
			expect(drainInfo()).toBeNull();
		} finally {
			gate.stop();
			upstream.close();
		}
	});

	test("root arms the drain; a second signal is refused 409", async () => {
		const { upstream } = await startHeldUpstream();
		const gate = await startGate(upstream.url);
		try {
			const res = await fetch(`${gate.base}/v1/admin/drain`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({ reason: "deployment:test", grace_ms: 1000 }),
			});
			expect(res.status).toBe(200);
			const out = (await res.json()) as {
				draining: boolean;
				reason: string;
				since_ms: number;
				deadline_ms: number;
			};
			expect(out.draining).toBe(true);
			expect(out.deadline_ms).toBeGreaterThan(out.since_ms);
			expect(drainInfo()?.reason).toBe("deployment:test");
			const second = await fetch(`${gate.base}/v1/admin/drain`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({ reason: "deployment:second" }),
			});
			expect(second.status).toBe(409);
			const err = (await second.json()) as { code: string };
			expect(err.code).toBe("buckle.already_draining");
		} finally {
			gate.stop();
			upstream.close();
		}
	});
});

describe("W1156 in-flight stream interruption", () => {
	const streamReq = (url: string): Request =>
		new Request(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
		});

	test("planned drain mid-turn: terminal then EOF; receipt is gateway_restarting", async () => {
		const { upstream, releases } = await startHeldUpstream();
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(streamReq(upstream.url));
			expect(res.status).toBe(200);
			const head = await readStream(res, (a) => a.includes("message_start"));
			expect(head).toContain("message_start");
			expect(beginDrain("deployment:test", 5000)).not.toBeNull();
			const tail = await readStream(res);
			expect(tail).toContain("gateway_restarting");
			expect(tail.indexOf("gateway_restarting")).toBeGreaterThan(
				head.indexOf("message_start"),
			);
			await Bun.sleep(80);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.decision).toBe("errored");
			expect(audit.error_code).toBe("gateway_restarting");
			expect(audit.err).toBe("gateway_restarting");
			expect(receiptOf(audit).terminal).toBe("gateway_restarting");
		} finally {
			for (const release of releases) release();
			upstream.close();
		}
	});

	test("in-band failure then later drain: first cause kept, no second restart error", async () => {
		const { upstream, releases } = await startHeldErrorUpstream();
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(streamReq(upstream.url));
			expect(res.status).toBe(200);
			// The real error reaches the client BEFORE any drain exists.
			const head = await readStream(res, (a) => a.includes("overloaded_error"));
			expect(head).toContain("overloaded_error");
			await Bun.sleep(80); // the sniffer branch settles before the drain fires
			expect(beginDrain("deployment:test", 5000)).not.toBeNull();
			const tail = await readStream(res);
			// The drain appends NOTHING after the real error the client holds.
			expect(tail).not.toContain("gateway_restarting");
			await Bun.sleep(80);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.decision).toBe("errored");
			// The durable receipt keeps the observed provider cause, not the drain.
			expect(audit.err).toBe("stream_failed:in_band:overloaded_error");
			expect(audit.error_code).toBe("stream_failed");
			expect(receiptOf(audit).terminal).toBe(
				"in_band_error:in_band:overloaded_error",
			);
		} finally {
			for (const release of releases) release();
			upstream.close();
		}
	});

	test("stream born mid-drain: immediate terminal, nothing else", async () => {
		const { upstream, releases } = await startHeldUpstream();
		try {
			beginDrain("deployment:test", 5000);
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(streamReq(upstream.url));
			const text = await res.text();
			expect(text).toContain("gateway_restarting");
			expect(text).not.toContain("message_start");
			await Bun.sleep(80);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).toBe("gateway_restarting");
		} finally {
			for (const release of releases) release();
			upstream.close();
		}
	});

	test("unexpected shutdown (no arming): no gateway_restarting, real cause kept", async () => {
		const { upstream } = await startHeldUpstream();
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(streamReq(upstream.url));
			const head = await readStream(res, (a) => a.includes("message_start"));
			expect(head).toContain("message_start");
			upstream.close(); // the upstream dies with no drain knowledge
			const tail = await readStream(res);
			expect(tail).not.toContain("gateway_restarting");
			await Bun.sleep(80);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.ok).toBe(0);
			expect(audit.error_code).not.toBe("gateway_restarting");
		} finally {
			upstream.close();
		}
	});

	test("drain racing a cancelled stream keeps downstream_cancel", async () => {
		const { upstream, releases } = await startHeldUpstream();
		try {
			const deps = testDeps(poolOf(upstream.url));
			const res = await createApp(deps).fetch(streamReq(upstream.url));
			const reader = res.body?.getReader();
			await reader?.read(); // first chunk delivered
			await reader?.cancel("client gone");
			await Bun.sleep(80); // the cancel hooks settle before the drain fires
			beginDrain("deployment:test", 5000);
			await Bun.sleep(80);
			const audit = deps.ledger.auditRows()[0] ?? {};
			expect(audit.error_code).toBe("downstream_cancel");
			expect(receiptOf(audit).terminal).toBe("downstream_cancel");
		} finally {
			for (const release of releases) release();
			upstream.close();
		}
	});
});
