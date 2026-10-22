import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { readRemoteTraces } from "../../telemetry/src/remote-traces.ts";

test("a real provider refusal retains bounded code type and call id in the admin trace", async () => {
	const dir = mkdtempSync(join(tmpdir(), "provider-feedback-"));
	let error: Record<string, unknown> = {
		code: 1302,
		type: "rate_limit_error",
		message: "synthetic provider capacity refusal",
	};
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			Response.json(
				{ error: { error } },
				{
					status: 429,
					headers: { "x-litellm-call-id": "provider-call-fixture" },
				},
			),
	});
	const policyPath = join(dir, "policy.json"),
		upstreamsPath = join(dir, "upstreams.json");
	writeFileSync(policyPath, JSON.stringify({ gateway: { num_retries: 0 } }));
	writeFileSync(
		upstreamsPath,
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${upstream.port}`,
						dialect: "openai",
					},
				],
			},
		}),
	);
	const server = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath,
		dbPath: ":memory:",
		auth: { rootKey: "feedback-fixture-root" },
	});
	const previousKey = process.env.W1191_PEER_KEY,
		previousPeers = process.env.BUCKLE_TRACE_PEERS_FILE;
	process.env.W1191_PEER_KEY = "feedback-fixture-root";
	delete process.env.BUCKLE_TRACE_PEERS_FILE;
	const frontPath = join(dir, "front.json"),
		peersPath = join(dir, "peers.json"),
		keyPath = join(dir, "read.key");
	writeFileSync(
		frontPath,
		JSON.stringify({
			groups: {
				fixture: [
					{
						url: `http://127.0.0.1:${server.port}`,
						dialect: "openai",
						api_key_env: "W1191_PEER_KEY",
					},
				],
			},
		}),
	);
	writeFileSync(keyPath, "feedback-fixture-root", { mode: 0o600 });
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
	const front = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath: frontPath,
		dbPath: ":memory:",
		auth: { rootKey: "feedback-fixture-root" },
	});
	const base = `http://127.0.0.1:${front.port}`,
		traceId = "d".repeat(32);
	const headers = { authorization: "Bearer feedback-fixture-root" };
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
		const trace = await (
			await fetch(`${base}/v1/admin/traces?trace_id=${traceId}`, { headers })
		).json();
		expect(trace.attempts).toHaveLength(1);
		expect(trace.attempts[0]).toMatchObject({
			status: 429,
			provider_error_code: "1302",
			provider_error_type: "rate_limit_error",
			call_id: "provider-call-fixture",
		});
		const remote = await readRemoteTraces(peersPath, traceId);
		expect(remote.peers[0].attempts[0]).toMatchObject({
			status: 429,
			provider_error_code: "1302",
			provider_error_type: "rate_limit_error",
			call_id: "provider-call-fixture",
		});
		expect(JSON.stringify(trace.attempts)).not.toContain(
			"synthetic provider capacity refusal",
		);
		const secret = ["bksk_", "syntheticcredential"].join("");
		error = { code: secret, type: "unsafe\nvalue", message: secret };
		const secondTrace = "e".repeat(32);
		const refused = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				...headers,
				traceparent: `00-${secondTrace}-1111111111111111-01`,
			},
			body: JSON.stringify({
				model: "fixture",
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(refused.status).toBe(429);
		await refused.text();
		const sanitized = await (
			await fetch(`${base}/v1/admin/traces?trace_id=${secondTrace}`, {
				headers,
			})
		).json();
		expect(sanitized.attempts[0]).toMatchObject({
			provider_error_code: null,
			provider_error_type: null,
		});
		expect(JSON.stringify(sanitized.attempts)).not.toContain(secret);
	} finally {
		front.stop(true);
		server.stop(true);
		upstream.stop(true);
		rmSync(dir, { recursive: true, force: true });
		if (previousKey === undefined) delete process.env.W1191_PEER_KEY;
		else process.env.W1191_PEER_KEY = previousKey;
		if (previousPeers === undefined) delete process.env.BUCKLE_TRACE_PEERS_FILE;
		else process.env.BUCKLE_TRACE_PEERS_FILE = previousPeers;
	}
});
