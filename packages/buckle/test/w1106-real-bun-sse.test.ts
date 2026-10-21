// W1106.1 canary — real Bun socket SSE survival past the 120s quiet wall.
// Live traces 096c5481… (local + hub) and 72be44e4… (IKEA) died at 119–126s
// when the upstream went quiet: Bun's default server idleTimeout (120s)
// closes the client socket even though the stream itself never failed. The
// W1106 transport checkpoint serves with idleTimeout 0. This canary drives a
// REAL TCP socket through the Anthropic SSE wire and proves:
//   1. an authorized request gets SSE headers + message_start immediately,
//   2. after >120s of upstream silence the same client socket is still open,
//   3. a real terminal event (message_stop) lands on that socket,
//   4. a client that disconnects mid-quiet tears the server stream down.
import { describe, expect, setDefaultTimeout, test } from "bun:test";

const QUIET_MS = 125_000; // must exceed the 120s default idle cutoff
const WIRE_AUTH = "Bearer canary-key";

const sse = (event: string, data: Record<string, unknown>): Uint8Array =>
	new TextEncoder().encode(
		`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
	);

interface Audit {
	events: string[];
	disconnected: boolean;
	cancelled: boolean;
	disconnectedAt: number;
	cancelledAt: number;
	terminalAuthoredAt: number;
	enqueueFailedAt: number;
	enqueueError: string;
}

// failure messages carry the exact source cancel/close timeline
const auditDump = (a: Audit): string =>
	JSON.stringify({
		...a,
		enqueueError: a.enqueueError || undefined,
	});

function startCanaryServer(quietMs: number) {
	const t0 = Date.now();
	const audit: Audit = {
		events: [],
		disconnected: false,
		cancelled: false,
		disconnectedAt: 0,
		cancelledAt: 0,
		terminalAuthoredAt: 0,
		enqueueFailedAt: 0,
		enqueueError: "",
	};
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0, // the W1106 transport checkpoint under test
		fetch(req) {
			if (req.headers.get("authorization") !== WIRE_AUTH)
				return new Response("unauthorized", { status: 401 });
			if (new URL(req.url).pathname !== "/v1/messages")
				return new Response("not found", { status: 404 });
			let closed = false;
			req.signal.addEventListener("abort", () => {
				audit.disconnected = true;
				audit.disconnectedAt = Date.now() - t0;
				closed = true;
			});
			const stream = new ReadableStream({
				start(c) {
					audit.events.push("message_start");
					c.enqueue(sse("message_start", { type: "message_start" }));
					const deadline = Date.now() + quietMs;
					const tick = setInterval(() => {
						if (closed) {
							clearInterval(tick);
							return;
						}
						if (Date.now() < deadline) return;
						clearInterval(tick);
						audit.events.push("message_stop");
						audit.terminalAuthoredAt = Date.now() - t0;
						closed = true;
						try {
							c.enqueue(sse("message_stop", { type: "message_stop" }));
							c.close();
						} catch (err) {
							// upstream tried to write into a closed controller: the
							// terminal never reached the client (the coordinator's
							// #55732 failure shape) — surface it, don't mask it.
							audit.enqueueFailedAt = Date.now() - t0;
							audit.enqueueError = String(err);
						}
					}, 250);
				},
				cancel() {
					audit.cancelled = true;
					audit.cancelledAt = Date.now() - t0;
					closed = true;
				},
			});
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		},
	});
	return { server, audit };
}

interface Client {
	socket: Bun.TCPSocket;
	firstSeenAt: () => number;
	terminalSeenAt: () => number;
	body: () => string;
}

async function openSseClient(port: number): Promise<Client> {
	let buf = "";
	let firstSeenAt = 0;
	let terminalSeenAt = 0;
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data(_s, chunk) {
				const text = new TextDecoder().decode(chunk);
				const now = Date.now();
				if (!firstSeenAt && text.includes("event: message_start"))
					firstSeenAt = now;
				if (!terminalSeenAt && text.includes("event: message_stop"))
					terminalSeenAt = now;
				buf += text;
			},
		},
	});
	const req = [
		"POST /v1/messages HTTP/1.1",
		`Host: 127.0.0.1:${port}`,
		`Authorization: ${WIRE_AUTH}`,
		"Content-Type: application/json",
		"Content-Length: 2",
		"",
		"{}",
	].join("\r\n");
	socket.write(req);
	return {
		socket,
		firstSeenAt: () => firstSeenAt,
		terminalSeenAt: () => terminalSeenAt,
		body: () => buf,
	};
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
		await Bun.sleep(50);
	}
}

describe("W1106.1 real Bun SSE canary", () => {
	setDefaultTimeout(220_000);

	test("quiet >120s upstream: terminal lands on the still-open client socket", async () => {
		const { server, audit } = startCanaryServer(QUIET_MS);
		const t0 = Date.now();
		const client = await openSseClient(server.port);
		await waitFor(() => client.firstSeenAt() > 0, 5_000, "first SSE event");
		expect(client.firstSeenAt() - t0).toBeLessThan(5_000);

		// unauthorized callers never reach the stream
		const anon = await fetch(`http://127.0.0.1:${server.port}/v1/messages`);
		expect(anon.status).toBe(401);

		// the quiet wall: no frames for >120s, then the terminal on the SAME socket
		await Bun.sleep(QUIET_MS + 3_000);
		// provenance: the terminal was authored by the upstream (this mock), past
		// the 120s wall, and enqueued cleanly — a Buckle-fabricated terminal or a
		// closed-controller enqueue failure (#55732 shape) fails these instead.
		expect(audit.terminalAuthoredAt, auditDump(audit)).toBeGreaterThan(120_000);
		expect(audit.enqueueFailedAt, auditDump(audit)).toBe(0);
		expect(audit.enqueueError, auditDump(audit)).toBe("");
		expect(
			client.terminalSeenAt() - client.firstSeenAt(),
			auditDump(audit),
		).toBeGreaterThan(120_000);
		expect(client.body()).toContain("event: message_stop");
		expect(audit.events).toContain("message_stop");
		expect(audit.disconnected, auditDump(audit)).toBe(false);
		expect(audit.cancelled, auditDump(audit)).toBe(false);

		client.socket.end();
		await server.stop(true);
	}, 220_000);

	test("client disconnect mid-quiet tears the server stream down", async () => {
		const { server, audit } = startCanaryServer(10_000);
		const client = await openSseClient(server.port);
		await waitFor(() => client.firstSeenAt() > 0, 5_000, "first SSE event");
		client.socket.end();
		await waitFor(
			() => audit.disconnected || audit.cancelled,
			10_000,
			"teardown signal",
		);
		expect(audit.disconnected || audit.cancelled).toBe(true);
		await server.stop(true);
	}, 30_000);
});
