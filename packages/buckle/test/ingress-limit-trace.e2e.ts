import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { boundedIngressRequest } from "../src/ingress-body.ts";
import { MAX_REQUEST_BODY_BYTES, startServer } from "../src/server.ts";

function gateway() {
	const world = scratchWorld({ prefix: "ingress-limit-trace-" });
	const policyPath = join(world.home, "policy.json");
	const upstreamsPath = join(world.home, "upstreams.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	writeFileSync(upstreamsPath, JSON.stringify({ groups: {} }));
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath,
		dbPath: join(world.home, "gateway.db"),
		auth: { rootKey: "test-root" },
	});
	return {
		server,
		close: () => {
			server.stop(true);
			world.clean();
		},
	};
}

const headers = {
	"content-type": "application/json",
	authorization: "Bearer test-root",
	traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
};

async function expectTraced413(response: Response): Promise<void> {
	expect(response.status).toBe(413);
	expect(response.headers.get("x-klh-trace-id")).toBe("a".repeat(32));
	expect(await response.json()).toMatchObject({
		code: "buckle.body_too_large",
		trace_id: "a".repeat(32),
		fleet_trace: { hops: [{ service: "buckle" }] },
	});
}

test("oversized declared body receives Buckle's traced 413 before routing @api", async () => {
	const { server, close } = gateway();
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.port}/v1/messages`,
			{
				method: "POST",
				headers,
				body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 120),
			},
		);
		await expectTraced413(response);
	} finally {
		close();
	}
});

test("oversized chunked body is stopped at the same cap with a trace @api", async () => {
	const { server, close } = gateway();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent++ <= 32) controller.enqueue(Buffer.alloc(1024 * 1024, 120));
			else controller.close();
		},
	});
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.port}/v1/messages`,
			{
				method: "POST",
				headers,
				body,
				duplex: "half",
			},
		);
		await expectTraced413(response);
	} finally {
		close();
	}
});

test("the outer guard never invokes an inner handler for oversized bodies @api", async () => {
	let handled = 0;
	const server = Bun.serve({
		port: 0,
		maxRequestBodySize: Infinity,
		async fetch(request) {
			const bounded = await boundedIngressRequest(request, 16);
			if (!bounded.ok)
				return new Response(bounded.code, { status: bounded.status });
			handled++;
			return new Response("handled");
		},
	});
	try {
		const response = await fetch(server.url, {
			method: "POST",
			body: "x".repeat(100),
		});
		expect(response.status).toBe(413);
		expect(handled).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("admitted bodies preserve method, headers, bytes and abort signal @api", async () => {
	const controller = new AbortController();
	const original = new Request("http://127.0.0.1/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", "x-test": "present" },
		body: '{"model":"fixture"}',
		signal: controller.signal,
	});
	const result = await boundedIngressRequest(original, 32);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.request.method).toBe("POST");
	expect(result.request.headers.get("x-test")).toBe("present");
	expect(await result.request.text()).toBe('{"model":"fixture"}');
	controller.abort();
	expect(result.request.signal.aborted).toBe(true);
});

test("stalled chunked ingestion stops at its deadline before routing @api", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise<void>(() => {});
		},
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request("http://127.0.0.1/test", {
		method: "POST",
		body,
		duplex: "half",
	});
	const result = await boundedIngressRequest(request, 16, 20);
	expect(result).toMatchObject({
		ok: false,
		status: 408,
		code: "buckle.body_timeout",
	});
	expect(cancelled).toBe(true);
});

test("malformed raw HTTP remains Bun's pre-application parser boundary @api", async () => {
	let fetched = 0;
	let errored = 0;
	const server = Bun.serve({
		port: 0,
		maxRequestBodySize: Infinity,
		fetch() {
			fetched++;
			return new Response("app");
		},
		error() {
			errored++;
			return new Response("handler");
		},
	});
	try {
		const status = await new Promise<string>((resolve, reject) => {
			let text = "";
			void Bun.connect({
				hostname: "127.0.0.1",
				port: server.port,
				socket: {
					open(socket) {
						socket.write(
							"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: invalid\r\n\r\n",
						);
					},
					data(socket, data) {
						text += Buffer.from(data).toString("utf8");
						if (text.includes("\r\n")) {
							resolve(text.split("\r\n")[0] ?? "");
							socket.end();
						}
					},
					close() {
						resolve(text.split("\r\n")[0] ?? "");
					},
					error(error) {
						reject(error);
					},
				},
			}).catch(reject);
		});
		expect(status).toBe("HTTP/1.1 400 Bad Request");
		expect(fetched).toBe(0);
		expect(errored).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("an inner hub's 413 retains its origin across a second Buckle hub @api", async () => {
	const world = scratchWorld({ prefix: "ingress-limit-relay-" });
	const priorHub = process.env.BUCKLE_HUB_ID;
	const priorKey = process.env.INGRESS_LIMIT_PEER_KEY;
	const policyPath = join(world.home, "policy.json");
	const innerPool = join(world.home, "inner-upstreams.json");
	const outerPool = join(world.home, "outer-upstreams.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	writeFileSync(innerPool, JSON.stringify({ groups: {} }));
	let inner: ReturnType<typeof startServer> | undefined;
	let outer: ReturnType<typeof startServer> | undefined;
	try {
		process.env.BUCKLE_HUB_ID = "inner";
		inner = startServer({
			port: 0,
			hostname: "127.0.0.1",
			policyPath,
			upstreamsPath: innerPool,
			dbPath: join(world.home, "inner.db"),
			auth: { rootKey: "test-root" },
			ingressBodyMaxBytes: 1024,
		});
		process.env.INGRESS_LIMIT_PEER_KEY = "test-root";
		writeFileSync(
			outerPool,
			JSON.stringify({
				groups: {
					fixture: [
						{
							url: `http://127.0.0.1:${inner.port}`,
							dialect: "anthropic",
							buckle: true,
							api_key_env: "INGRESS_LIMIT_PEER_KEY",
						},
					],
				},
			}),
		);
		process.env.BUCKLE_HUB_ID = "outer";
		outer = startServer({
			port: 0,
			hostname: "127.0.0.1",
			policyPath,
			upstreamsPath: outerPool,
			dbPath: join(world.home, "outer.db"),
			auth: { rootKey: "test-root" },
		});
		const response = await fetch(`http://127.0.0.1:${outer.port}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "fixture",
				max_tokens: 8,
				messages: [{ role: "user", content: "x".repeat(2048) }],
			}),
		});
		// The outer hub reports a 502 for its failed upstream attempt, while
		// the trace preserves the inner hub's actual 413 and origin.
		expect(response.status).toBe(502);
		expect(response.headers.get("x-klh-trace-id")).toBe("a".repeat(32));
		expect(response.headers.get("x-klh-error-origin")).toBe("inner");
		expect(await response.json()).toMatchObject({
			trace_id: "a".repeat(32),
			fleet_trace: {
				hops: [
					{ hub: "inner", status: 413, code: "buckle.body_too_large" },
					{ hub: "outer", status: 502, upstream_status: 413 },
				],
			},
		});
	} finally {
		outer?.stop(true);
		inner?.stop(true);
		world.clean();
		if (priorHub === undefined) delete process.env.BUCKLE_HUB_ID;
		else process.env.BUCKLE_HUB_ID = priorHub;
		if (priorKey === undefined) delete process.env.INGRESS_LIMIT_PEER_KEY;
		else process.env.INGRESS_LIMIT_PEER_KEY = priorKey;
	}
});
