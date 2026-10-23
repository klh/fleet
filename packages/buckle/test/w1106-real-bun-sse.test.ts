// W1106.1 canary — real Bun socket SSE survival past the 120s quiet wall.
// Live traces 096c5481… (local + hub) and 72be44e4… (IKEA) died at 119–126s
// when the upstream went quiet: Bun's default server idleTimeout (120s)
// closes the client socket even though the stream itself never failed. The
// W1106 transport checkpoint serves with idleTimeout 0.
//
// Two legs:
//   control  — direct Bun.serve({idleTimeout:0}) → raw socket client. Proves
//              the runtime surface alone holds a >120s quiet SSE stream.
//   chain    — raw socket client → REAL startServer Buckle → tagged mock
//              upstream on 127.0.0.1. The release question is this proxy
//              chain (coordinator canary #55745: first chunk 11ms,
//              upstream-authored stop at 125010ms, client receipt 125011ms).
//              Every mock request is TAGGED (n/method/path/arrival/cancel)
//              so the boot pre-warm probe (GET /v1/models, 4s abort budget
//              — src/pool-warm.ts) can never masquerade as the inference
//              stream (#55743); assertions carry the audit dump so a
//              failure names WHO closed the stream and WHEN (#55732).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

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

async function openSseClient(port: number, body = "{}"): Promise<Client> {
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
		`Content-Length: ${body.length}`,
		"",
		body,
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

interface ChainCall {
	n: number;
	method: string;
	path: string;
	arrivalAt: number;
}

interface ChainAudit {
	calls: ChainCall[];
	startAuthoredAt: number;
	terminalAuthoredAt: number;
	cancelledAt: 0 | number;
	enqueueFailedAt: number;
	enqueueError: string;
}

const chainDump = (a: ChainAudit): string => JSON.stringify(a);

const chainReceipt = (row: Record<string, unknown>): Record<string, unknown> =>
	JSON.parse(String(row.stream_receipt ?? "{}")) as Record<string, unknown>;

// arm the quiet deadline: message_stop authored after quietMs; an enqueue
// into a closed controller is captured, never masked (#55732). quietMs of
// Infinity never fires — only cancellation ends the stream.
function armQuietTick(
	c: ReadableStreamDefaultController<Uint8Array>,
	audit: ChainAudit,
	t0: number,
	quietMs: number,
	isClosed: () => boolean,
): void {
	const deadline = Date.now() + quietMs;
	const tick = setInterval(() => {
		if (isClosed()) {
			clearInterval(tick);
			return;
		}
		if (Date.now() < deadline) return;
		clearInterval(tick);
		audit.terminalAuthoredAt = Date.now() - t0;
		try {
			c.enqueue(sse("message_stop", { type: "message_stop" }));
			c.close();
		} catch (err) {
			audit.enqueueFailedAt = Date.now() - t0;
			audit.enqueueError = String(err);
		}
	}, 250);
}

function quietSseStream(
	audit: ChainAudit,
	quietMs: number,
): ReadableStream<Uint8Array> {
	const t0 = Date.now();
	let closed = false;
	return new ReadableStream({
		start(c) {
			audit.startAuthoredAt = Date.now() - t0;
			c.enqueue(
				sse("message_start", {
					type: "message_start",
					message: { usage: { input_tokens: 1 } },
				}),
			);
			armQuietTick(c, audit, t0, quietMs, () => closed);
		},
		cancel() {
			audit.cancelledAt = Date.now() - t0;
			closed = true;
		},
	});
}

const recordCall = (audit: ChainAudit, req: Request, t0: number): void => {
	audit.calls.push({
		n: audit.calls.length + 1,
		method: req.method,
		path: new URL(req.url).pathname,
		arrivalAt: Date.now() - t0,
	});
};

function startTaggedUpstream(quietMs: number) {
	const t0 = Date.now();
	const audit: ChainAudit = {
		calls: [],
		startAuthoredAt: 0,
		terminalAuthoredAt: 0,
		cancelledAt: 0,
		enqueueFailedAt: 0,
		enqueueError: "",
	};
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0, // the mock never cuts its own quiet stream
		fetch(req) {
			recordCall(audit, req, t0);
			const path = new URL(req.url).pathname;
			if (req.method === "GET" && path === "/v1/models")
				return Response.json({ data: [{ id: "claude-sonnet-5" }] });
			if (req.method !== "POST" || path !== "/v1/messages")
				return new Response("not found", { status: 404 });
			return new Response(quietSseStream(audit, quietMs), {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		audit,
		close: () => server.stop(true),
	};
}

// REAL startServer Buckle between the raw-socket client and the mock: the
// gate ON (rootKey), temp upstreams+policy, :memory: ledger. The W1106 law
// under test rides this server's Bun.serve idleTimeout (BUN_IDLE_TIMEOUT).
async function startChainBuckle(mockUrl: string): Promise<{
	server: ReturnType<typeof startServer>;
	dir: string;
}> {
	const dir = mkdtempSync(join(tmpdir(), "w1106-chain-"));
	await Bun.write(
		join(dir, "upstreams.yaml"),
		`groups:\n  claude-sonnet-5:\n    - url: ${mockUrl}\n      dialect: anthropic\n`,
	);
	await Bun.write(
		join(dir, "policy.yaml"),
		"gateway:\n" +
			"  num_retries: 0\n" +
			"  request_timeout_s: 120\n" +
			"  first_byte_budget_s: 400\n" +
			"  stream_idle_timeout_s: 300\n" +
			"  stream_total_timeout_s: 400\n",
	);
	const server = startServer({
		port: 0,
		upstreamsPath: join(dir, "upstreams.yaml"),
		policyPath: join(dir, "policy.yaml"),
		dbPath: ":memory:",
		auth: { rootKey: "canary-key" },
	});
	return { server, dir };
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

	test("chain: REAL Buckle holds the client socket past a >120s quiet upstream", async () => {
		const mock = startTaggedUpstream(QUIET_MS);
		const { server } = await startChainBuckle(mock.url);
		const t0 = Date.now();
		const client = await openSseClient(
			server.port,
			JSON.stringify({ model: "claude-sonnet-5", stream: true }),
		);
		await waitFor(() => client.firstSeenAt() > 0, 5_000, "first SSE event");
		expect(client.firstSeenAt() - t0).toBeLessThan(5_000);
		await Bun.sleep(QUIET_MS + 3_000);
		const a = mock.audit;
		const dump = chainDump(a);
		const row = server.gov.ledger.auditRows()[0] ?? {};
		const posts = a.calls.filter((c) => c.path === "/v1/messages");
		expect(posts, dump).toHaveLength(1);
		expect(posts[0]?.arrivalAt, dump).toBeLessThan(5_000);
		expect(
			a.calls.some((c) => c.path === "/v1/models"),
			dump,
		).toBe(true);
		expect(a.terminalAuthoredAt, dump).toBeGreaterThan(120_000);
		expect(a.enqueueFailedAt, dump).toBe(0);
		expect(a.enqueueError, dump).toBe("");
		const saw = client.terminalSeenAt() - client.firstSeenAt();
		expect(saw, dump).toBeGreaterThan(120_000);
		expect(client.body()).toContain("event: message_stop");
		expect(a.cancelledAt, dump).toBe(0);
		expect(row.ok).toBe(1);
		expect(row.error_code).toBeNull();
		expect(chainReceipt(row).terminal).toBe("upstream_eof");
		server.stop(true);
		mock.close();
	}, 220_000);

	test("chain: client disconnect mid-quiet cancels the tagged upstream", async () => {
		const mock = startTaggedUpstream(Number.POSITIVE_INFINITY);
		const { server } = await startChainBuckle(mock.url);
		const client = await openSseClient(
			server.port,
			JSON.stringify({ model: "claude-sonnet-5", stream: true }),
		);
		await waitFor(() => client.firstSeenAt() > 0, 5_000, "first SSE event");
		client.socket.end();
		await waitFor(() => mock.audit.cancelledAt > 0, 10_000, "upstream cancel");
		await waitFor(
			() => server.gov.ledger.auditRows().length > 0,
			5_000,
			"cancel audit row",
		);
		const row = server.gov.ledger.auditRows()[0] ?? {};
		expect(mock.audit.cancelledAt, chainDump(mock.audit)).toBeGreaterThan(0);
		expect(row.ok).toBe(0);
		expect(row.error_code).toBe("downstream_cancel");
		expect(chainReceipt(row).terminal).toBe("downstream_cancel");
		expect(
			mock.audit.calls.filter((c) => c.path === "/v1/messages"),
		).toHaveLength(1);
		server.stop(true);
		mock.close();
	}, 30_000);
});
