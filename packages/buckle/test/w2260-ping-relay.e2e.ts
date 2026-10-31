// W2260: deterministic two-hop ping relay — the incident shape, shrunk.
// Inner upstream emits VALID ping keepalives for >60s, then completes the
// turn semantically. A REAL startServer Buckle sits between it and the
// client with a SHORT stream idle deadline (5s « the quiet wall): the
// outer hop must
//   • receive canonical `: keepalive` comment bytes through the reframer
//     (dropped-ping logs do NOT mean the outer hop starved),
//   • survive the 5s idle deadline on ping activity alone,
//   • deliver the complete native SSE turn with NO client-visible ping
//     semantics and no corrupted events,
// and bank terminal=upstream_eof, ok:1, activity=semantic.
// The true-stall sibling proves pings do NOT mask a real stall: a silent
// upstream trips the idle deadline and the receipt says upstream_deadline.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startServer } from "../src/server.ts";

const WIRE_AUTH = "Bearer w2260-key";
const PING_MS = 250;
const QUIET_MS = 61_000; // must exceed the 60s incident wall
const enc = new TextEncoder();

const sse = (event: string, data: Record<string, unknown>): Uint8Array =>
	enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

interface UpAudit {
	posts: number;
	pings: number;
	completedAt: number;
	cancelled: boolean;
}

interface ClientAudit {
	startSeen: boolean;
	keepalives: number;
	pingSemantics: number;
	terminalSeen: boolean;
	errorSeen: boolean;
	socketClosed: boolean;
	closedAt: number;
}

/** The origin mock: message_start → pings every PING_MS for quietMs →
 *  semantic completion. Cancel/cleanup audited. */
function startPingUpstream(quietMs: number) {
	const t0 = Date.now();
	const audit: UpAudit = {
		posts: 0,
		pings: 0,
		completedAt: 0,
		cancelled: false,
	};
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (req.method === "GET" && path === "/v1/models")
				return Response.json({ data: [{ id: "claude-sonnet-5" }] });
			if (req.method !== "POST" || path !== "/v1/messages")
				return new Response("not found", { status: 404 });
			audit.posts++;
			return new Response(
				pingStream(quietMs, audit, t0),
				{
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					},
				},
			);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, audit, close: () => server.stop(true) };
}

/** The SSE body: message_start, then valid pings until quietMs has passed,
 *  then the semantic completion (delta + stop) and a clean close. */
function pingStream(
	quietMs: number,
	audit: UpAudit,
	t0: number,
): ReadableStream<Uint8Array> {
	let closed = false;
	return new ReadableStream({
		start(c) {
			c.enqueue(
				sse("message_start", {
					type: "message_start",
					message: { usage: { input_tokens: 1 } },
				}),
			);
			const deadline = Date.now() + quietMs;
			const tick = setInterval(() => {
				if (closed) {
					clearInterval(tick);
					return;
				}
				if (Date.now() < deadline) {
					audit.pings++;
					try {
						c.enqueue(sse("ping", { type: "ping" }));
					} catch {
						closed = true;
					}
					return;
				}
				clearInterval(tick);
				completeTurn(c, audit, t0);
			}, PING_MS);
		},
		cancel() {
			audit.cancelled = true;
			closed = true;
		},
	});
}

function completeTurn(
	c: ReadableStreamDefaultController<Uint8Array>,
	audit: UpAudit,
	t0: number,
): void {
	try {
		c.enqueue(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "he" },
			}),
		);
		c.enqueue(sse("message_stop", { type: "message_stop" }));
		c.close();
		audit.completedAt = Date.now() - t0;
	} catch {
		audit.cancelled = true;
	}
}

/** Raw-socket SSE client: counts canonical keepalive comments vs ping
 *  semantics, captures first bytes + close time. */
async function openClient(port: number): Promise<ClientAudit> {
	const a: ClientAudit = {
		startSeen: false,
		keepalives: 0,
		pingSemantics: 0,
		terminalSeen: false,
		errorSeen: false,
		socketClosed: false,
		closedAt: 0,
	};
	const t0 = Date.now();
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data(_s, chunk) {
				const text = new TextDecoder().decode(chunk);
				if (text.includes("event: message_start")) a.startSeen = true;
				a.keepalives += text.split(": keepalive").length - 1;
				a.pingSemantics += text.split("event: ping").length - 1;
				if (text.includes("event: message_stop")) a.terminalSeen = true;
				if (text.includes("event: error")) a.errorSeen = true;
			},
			close() {
				a.socketClosed = true;
				a.closedAt = Date.now() - t0;
			},
		},
	});
	writeRequest(socket, port);
	return a;
}

function writeRequest(
	socket: Bun.TCPSocket,
	port: number,
): void {
	const body = JSON.stringify({
		model: "claude-sonnet-5",
		stream: true,
		max_tokens: 16,
	});
	socket.write(
		[
			"POST /v1/messages HTTP/1.1",
			`Host: 127.0.0.1:${port}`,
			`Authorization: ${WIRE_AUTH}`,
			"Content-Type: application/json",
			"Connection: close",
			`Content-Length: ${Buffer.byteLength(body)}`,
			"",
			body,
		].join("\r\n"),
	);
}

/** A REAL startServer Buckle between client and upstream, with a SHORT
 *  stream idle deadline (config-over-code: the policy file carries it). */
async function startBuckle(
	upstreamUrl: string,
	idleS: number,
): Promise<ReturnType<typeof startServer>> {
	const dir = mkdtempSync(join(tmpdir(), "w2260-relay-"));
	// W1253 Amendment A: fleet config is JSON — JSON.parse is the one parser
	await Bun.write(
		join(dir, "upstreams.json"),
		JSON.stringify({
			groups: {
				"claude-sonnet-5": [{ url: upstreamUrl, dialect: "anthropic" }],
			},
		}),
	);
	await Bun.write(
		join(dir, "policy.json"),
		JSON.stringify({
			gateway: {
				num_retries: 0,
				request_timeout_s: 120,
				stream_idle_timeout_s: idleS,
				stream_total_timeout_s: 400,
			},
		}),
	);
	return startServer({
		port: 0,
		upstreamsPath: join(dir, "upstreams.json"),
		policyPath: join(dir, "policy.json"),
		dbPath: ":memory:",
		auth: { rootKey: "w2260-key" },
	});
}

const waitFor = async (
	cond: () => boolean,
	timeoutMs: number,
	what: string,
	dump?: () => string,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline)
			throw new Error(`timeout waiting ${what}${dump ? `: ${dump()}` : ""}`);
		await Bun.sleep(50);
	}
};

test.describe.configure({ mode: "serial" });
test.setTimeout(140_000);

test("W2260 ping relay: >60s of pings then completion survives the idle wall", async () => {
	const up = startPingUpstream(QUIET_MS);
	const buckle = await startBuckle(up.url, 5);
	const a = await openClient(buckle.port);
	try {
		await waitFor(
			() => a.terminalSeen && a.socketClosed,
			QUIET_MS + 20_000,
			"complete turn",
			() => JSON.stringify({ client: a, upstream: up.audit }),
		);
		expect(a.pingSemantics).toBe(0);
		expect(a.keepalives).toBeGreaterThan(100);
		expect(a.startSeen).toBe(true);
		expect(up.audit.completedAt).toBeGreaterThan(60_000);
		expect(up.audit.cancelled).toBe(false);
		expect(a.closedAt).toBeGreaterThan(60_000);
	} finally {
		buckle.stop(true);
		up.close();
	}
});

test("W2260 true stall: no bytes at all trips the idle deadline", async () => {
	const up = startSilentUpstream();
	const buckle = await startBuckle(up.url, 2);
	const a = await openClient(buckle.port);
	try {
		await waitFor(
			() => a.errorSeen || a.socketClosed,
			15_000,
			"idle deadline",
			() => JSON.stringify(a),
		);
		expect(a.startSeen).toBe(true);
		expect(a.terminalSeen).toBe(false);
		expect(a.keepalives).toBe(0);
		expect(a.errorSeen).toBe(true);
		const row = (buckle.gov.ledger.auditRows()[0] ?? {}) as Record<
			string,
			unknown
		>;
		expect(row.err).toBe("stream_failed:timeout");
		expect(row.ok).toBe(0);
		const receipt = JSON.parse(String(row.stream_receipt ?? "{}"));
		expect(receipt.terminal).toBe("upstream_deadline");
		// the mock emits message_start then stalls — one semantic frame, so
		// the receipt says semantic (retry is NOT eligible past first byte)
		expect(receipt.activity).toBe("semantic");
		expect(receipt.retry_eligible).toBe(false);
	} finally {
		buckle.stop(true);
		up.close();
	}
});

/** The stall mock: message_start then silence — the 188-bytes-then-idle
 *  incident shape (activity semantic, past the retry boundary). */
function startSilentUpstream() {
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (req.method === "GET" && path === "/v1/models")
				return Response.json({ data: [{ id: "claude-sonnet-5" }] });
			if (req.method !== "POST" || path !== "/v1/messages")
				return new Response("not found", { status: 404 });
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(
							sse("message_start", {
								type: "message_start",
								message: { usage: { input_tokens: 1 } },
							}),
						);
					},
				}),
				{
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					},
				},
			);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

