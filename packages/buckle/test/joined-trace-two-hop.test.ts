// test/joined-trace-two-hop.test.ts — W1124.42: the joined Buckle trace must
// retain safe remote target + refusal attribution (candidate, refusal,
// upstream_refusal_code, refusal_origin, request target origin/model) and a
// cancellation's final receipt must truthfully retain the attempt's evidence.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HopReceipt } from "@klh/telemetry/src/http-trace.ts";
import { readRemoteTraces } from "@klh/telemetry/src/remote-traces.ts";
import { Router, UpstreamError } from "../src/router.ts";
import { startServer } from "../src/server.ts";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface RouterMetricsShim {
	fallback(tier: string): void;
	cooldown(dep: string): void;
	refused(tier: string): void;
	attempt?(receipt: HopReceipt): void;
}

interface RouterDepsPool {
	groups(): string[];
	deployments(group: string): Array<{
		group: string;
		url: string;
		dialect: "anthropic";
	}>;
}

function receiptSink(): {
	receipts: HopReceipt[];
	metrics: RouterMetricsShim;
} {
	const receipts: HopReceipt[] = [];
	return {
		receipts,
		metrics: {
			fallback: () => {},
			cooldown: () => {},
			refused: () => {},
			attempt: (receipt) => receipts.push(receipt),
		},
	};
}

function poolOf(group: string): RouterDepsPool {
	return {
		groups: () => [group],
		deployments: (g) => [
			{
				group: g,
				url: `http://${g}.example.invalid/private`,
				dialect: "anthropic",
			},
		],
	};
}

/** Drives one walk whose single leg aborts the client signal mid-attempt.
 *  `throws` is the error the leg dies with (the upstream truth racing the
 *  hangup); receipts land in the returned sink. */
async function cancelledRun(
	throws: () => Promise<never>,
): Promise<{ result: { kind: string }; receipts: HopReceipt[] }> {
	const { receipts, metrics } = receiptSink();
	const ctrl = new AbortController();
	const router = new Router(
		{ num_retries: 0 },
		{
			pool: poolOf("primary"),
			metrics,
			fetchImpl: async () => {
				ctrl.abort();
				await throws();
				throw new Error("unreachable");
			},
		},
	);
	const result = await router.execute({
		group: "primary",
		dialect: "anthropic",
		path: "/v1/messages",
		body: { model: "primary", messages: [{ role: "user", content: "hi" }] },
		key: "fixture-key",
		rid: "rid-1",
		trace: { traceparent: TRACEPARENT, baggage: null },
		signal: ctrl.signal,
	});
	return { result, receipts };
}

test("cancelled leg with upstream truth retains its network attribution", async () => {
	const { result, receipts } = await cancelledRun(async () => {
		throw new UpstreamError(
			502,
			"upstream 127.0.0.1:9 unreachable",
			"upstream",
			true,
			"pool-x",
			250,
		);
	});
	expect(result.kind).toBe("aborted");
	expect(receipts).toHaveLength(1);
	expect(receipts[0]).toMatchObject({
		refusal: "downstream_cancel",
		status: null,
		refusalOrigin: "network",
		providerPool: "pool-x",
		queueWaitMs: 250,
	});
});

test("plain hangup with no upstream boundary stays a plain cancel", async () => {
	const { result, receipts } = await cancelledRun(async () => {
		throw new Error("client gave up");
	});
	expect(result.kind).toBe("aborted");
	expect(receipts).toHaveLength(1);
	expect(receipts[0]).toMatchObject({
		refusal: "downstream_cancel",
		status: null,
		refusalOrigin: null,
	});
});

/** The far leg: a provider-shaped 429 — litellm envelope, provider call id,
 *  and the hop refusal header upstream_refusal_code rides (x-klh-refusal). */
function refusingUpstream(): { port: number; stop(): void } {
	const inner = JSON.stringify({
		type: "error",
		error: {
			code: "1302",
			type: "rate_limit_error",
			message: "provider capacity",
		},
	});
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json(
				{
					error: {
						error: {
							type: "rate_limit_error",
							message: `litellm.RateLimitError: ${inner}`,
						},
					},
				},
				{
					status: 429,
					headers: {
						"x-litellm-call-id": "provider-call-fixture",
						"x-klh-refusal": "rate_limit_error",
					},
				},
			),
	});
	return { port: upstream.port, stop: () => upstream.stop(true) };
}

type HopHarness = {
	front: ReturnType<typeof startServer>;
	server: ReturnType<typeof startServer>;
	upstream: { port: number; stop(): void };
	peersPath: string;
	dir: string;
};

/** Front hub → server hub → refusing upstream: root-key auth, peers + 0600 key. */
function twoHop(): HopHarness {
	const dir = mkdtempSync(join(tmpdir(), "joined-trace-"));
	const policyPath = join(dir, "policy.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	const upstream = refusingUpstream();
	writeFileSync(
		join(dir, "server-upstreams.json"),
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${upstream.port}`,
						dialect: "openai",
						model: "gemini-4.5",
					},
				],
			},
		}),
	);
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath: join(dir, "server-upstreams.json"),
		dbPath: ":memory:",
		auth: { rootKey: "joined-fixture-root" },
	});
	writeFileSync(
		join(dir, "front-upstreams.json"),
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${server.port}`,
						dialect: "openai",
						api_key_env: "JOINED_PEER_KEY",
					},
				],
			},
		}),
	);
	process.env.JOINED_PEER_KEY = "joined-fixture-root";
	const front = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath: join(dir, "front-upstreams.json"),
		dbPath: ":memory:",
		auth: { rootKey: "joined-fixture-root" },
	});
	const peersPath = join(dir, "peers.json"),
		keyPath = join(dir, "read.key");
	writeFileSync(keyPath, "joined-fixture-root", { mode: 0o600 });
	writeFileSync(
		peersPath,
		JSON.stringify({
			peers: [
				{
					hubId: "fixture",
					url: `http://127.0.0.1:${server.port}`,
					tokenFile: keyPath,
				},
			],
		}),
		{ mode: 0o600 },
	);
	delete process.env.BUCKLE_TRACE_PEERS_FILE;
	return { front, server, upstream, peersPath, dir };
}

test("remote projection retains refusal attribution across the joined trace", async () => {
	const previousPeers = process.env.BUCKLE_TRACE_PEERS_FILE;
	const { front, server, upstream, peersPath, dir } = twoHop();
	const base = `http://127.0.0.1:${front.port}`,
		headers = { authorization: "Bearer joined-fixture-root" },
		traceId = "b".repeat(32);
	try {
		const response = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { ...headers, traceparent: `00-${traceId}-1111111111111111-01` },
			body: JSON.stringify({
				model: "fixture",
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(response.status).toBe(429);
		await response.text();
		const remote = await readRemoteTraces(peersPath, traceId);
		const peer = remote.peers[0];
		expect(peer.attempts[0]).toMatchObject({
			status: 429,
			refusal: "rate_limited",
			refusal_origin: "upstream",
			upstream_refusal_code: "rate_limit_error",
			call_id: "provider-call-fixture",
		});
		expect(peer.attempts[0]?.candidate).toMatch(/^[0-9a-f]{16}$/);
	} finally {
		front.stop(true);
		server.stop(true);
		upstream.stop(true);
		rmSync(dir, { recursive: true, force: true });
		if (previousPeers === undefined) delete process.env.BUCKLE_TRACE_PEERS_FILE;
		else process.env.BUCKLE_TRACE_PEERS_FILE = previousPeers;
	}
});

test("remote projection retains the safe request target rows across the joined trace", async () => {
	const previousPeers = process.env.BUCKLE_TRACE_PEERS_FILE;
	const { front, server, upstream, peersPath, dir } = twoHop();
	const base = `http://127.0.0.1:${front.port}`,
		headers = { authorization: "Bearer joined-fixture-root" },
		traceId = "c".repeat(32);
	try {
		const response = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { ...headers, traceparent: `00-${traceId}-1111111111111111-01` },
			body: JSON.stringify({
				model: "fixture",
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(response.status).toBe(429);
		await response.text();
		const remote = await readRemoteTraces(peersPath, traceId);
		const peer = remote.peers[0];
		expect(peer.requests[0]).toMatchObject({
			ok: 0,
			status: 429,
			target_kind: "local",
			target_host: "127.0.0.1",
			target_port: upstream.port,
			target_model: "gemini-4.5",
		});
		expect(peer.requests).toHaveLength(1);
	} finally {
		front.stop(true);
		server.stop(true);
		upstream.stop(true);
		rmSync(dir, { recursive: true, force: true });
		if (previousPeers === undefined) delete process.env.BUCKLE_TRACE_PEERS_FILE;
		else process.env.BUCKLE_TRACE_PEERS_FILE = previousPeers;
	}
});
