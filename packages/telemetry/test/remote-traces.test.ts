import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteTraces } from "../src/remote-traces.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(url = "http://127.0.0.1:4301/") {
	const dir = mkdtempSync(join(tmpdir(), "fleet-trace-peers-"));
	dirs.push(dir);
	const tokenFile = join(dir, "read.key");
	const configFile = join(dir, "peers.json");
	writeFileSync(tokenFile, "private-admin-read-key\n", { mode: 0o600 });
	writeFileSync(
		configFile,
		JSON.stringify({ peers: [{ hubId: "zai", url, tokenFile }] }),
		{ mode: 0o600 },
	);
	return { tokenFile, configFile };
}

const traceId = "a".repeat(32);

test("fixed private peer returns bounded, body-free remote attempts", async () => {
	const { configFile } = fixture();
	let called = false;
	const read = await readRemoteTraces(
		configFile,
		traceId,
		async (url, init) => {
			called = true;
			expect(url.toString()).toBe(
				`http://127.0.0.1:4301/v1/admin/traces?trace_id=${traceId}`,
			);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer private-admin-read-key",
			);
			expect(init?.redirect).toBe("error");
			return Response.json({
				trace_id: traceId,
				attempts: [
					{
						trace_id: traceId,
						rid: "request-1",
						ordinal: 1,
						ts: "2026-10-21T11:00:00.000Z",
						hop: "litellm",
						status: 503,
						candidate: "a1b2c3d4e5f60718",
						refusal: "network",
						upstream_refusal_code: "rate_limit_error",
						refusal_origin: "upstream",
						duration_ms: 23,
						retry_after_ms: 5000,
						call_id: "call-1",
						provider_pool: "account",
						queue_wait_ms: 123,
						provider_error_code: "1302",
						provider_error_type: "rate_limit_error",
						body: "secret prompt",
					},
				],
				requests: [
					{
						rid: "request-1",
						ts: "2026-10-21T11:00:00.000Z",
						lane: "autow1124",
						ok: 0,
						status: 503,
						attempts: 2,
						target_kind: "cloud",
						target_host: "127.0.0.1",
						target_port: 4301,
						target_model: "gemini-4.5",
					},
					{ rid: "junk", body: "leak" },
				],
			});
		},
	);
	expect(called).toBe(true);
	expect(read).toMatchObject({
		status: "ok",
		peers: [
			{
				hub_id: "zai",
				status: "ok",
				attempts: [
					{
						hub_id: "zai",
						trace_id: traceId,
						ordinal: 1,
						status: 503,
						candidate: "a1b2c3d4e5f60718",
						refusal: "network",
						upstream_refusal_code: "rate_limit_error",
						refusal_origin: "upstream",
						retry_after_ms: 5000,
						provider_pool: "account",
						queue_wait_ms: 123,
						provider_error_code: "1302",
						provider_error_type: "rate_limit_error",
					},
				],
				requests: [
					{
						rid: "request-1",
						lane: "autow1124",
						ok: 0,
						status: 503,
						attempts: 2,
						target_kind: "cloud",
						target_host: "127.0.0.1",
						target_port: 4301,
						target_model: "gemini-4.5",
					},
				],
			},
		],
	});
	expect(JSON.stringify(read)).not.toContain("secret prompt");
	expect(JSON.stringify(read)).not.toContain("leak");
	expect(JSON.stringify(read)).not.toContain("private-admin-read-key");
});

test("request projection keeps slash models and redacts credential-shaped values", async () => {
	const { configFile } = fixture();
	const slashRow = {
		rid: "req-slash",
		ts: "2026-10-21T11:00:00.000Z",
		ok: 0,
		status: 499,
		attempts: 1,
		target_kind: "local",
		target_host: "127.0.0.1",
		target_port: 1,
		target_model: "chatgpt/gpt-6-sol",
	};
	const read = await readRemoteTraces(configFile, traceId, async () =>
		Response.json({
			trace_id: traceId,
			attempts: [],
			requests: [slashRow],
		}),
	);
	const rows = read.peers[0]?.requests ?? [];
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ target_model: "chatgpt/gpt-6-sol" });
	// credential-shaped host AND model both redact to null (W1124.42.1)
	const secretRow = {
		rid: "req-secret",
		ts: "2026-10-21T11:00:01.000Z",
		ok: 0,
		status: 499,
		attempts: 1,
		target_kind: "local",
		target_host: "bksk_fixture_secret",
		target_port: 1,
		target_model: "bksk_fixture_secret",
	};
	const secretRead = await readRemoteTraces(configFile, traceId, async () =>
		Response.json({
			trace_id: traceId,
			attempts: [],
			requests: [secretRow],
		}),
	);
	const secretRows = secretRead.peers[0]?.requests ?? [];
	expect(secretRows).toHaveLength(1);
	expect(secretRows[0]).toMatchObject({
		rid: "req-secret",
		target_host: null,
		target_model: null,
	});
	expect(JSON.stringify(secretRead)).not.toContain("bksk_fixture_secret");
});

test("missing, loose, and unsafe peer config fail closed", async () => {
	expect(await readRemoteTraces(undefined, traceId)).toEqual({
		status: "not_configured",
		peers: [],
		coverage: { hubs: 0, ok: 0, degraded: 0, by_hub: {} },
	});
	const { configFile } = fixture("http://192.0.2.1:4301/");
	expect(await readRemoteTraces(configFile, traceId)).toEqual({
		status: "invalid_config",
		peers: [],
		coverage: { hubs: 0, ok: 0, degraded: 0, by_hub: {} },
	});
	chmodSync(configFile, 0o644);
	expect(await readRemoteTraces(configFile, traceId)).toEqual({
		status: "invalid_config",
		peers: [],
		coverage: { hubs: 0, ok: 0, degraded: 0, by_hub: {} },
	});
});

test("peer failure is explicit and cannot hide healthy peers", async () => {
	const { configFile } = fixture();
	const read = await readRemoteTraces(configFile, traceId, async () => {
		throw new Error("connection refused with secret");
	});
	expect(read).toEqual({
		status: "ok",
		peers: [
			{ hub_id: "zai", status: "unavailable", attempts: [], requests: [] },
		],
		coverage: { hubs: 1, ok: 0, degraded: 1, by_hub: { zai: "unavailable" } },
	});
});

test("coverage reports the per-read map across a mixed peer set", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-trace-peers-"));
	dirs.push(dir);
	const tokenFile = join(dir, "read.key");
	const configFile = join(dir, "peers.json");
	writeFileSync(tokenFile, "private-admin-read-key\n", { mode: 0o600 });
	writeFileSync(
		configFile,
		JSON.stringify({
			peers: [
				{ hubId: "nas", url: "http://127.0.0.1:4302/", tokenFile },
				{ hubId: "desktop", url: "http://127.0.0.1:4303/", tokenFile },
			],
		}),
		{ mode: 0o600 },
	);
	const read = await readRemoteTraces(configFile, traceId, async (url) => {
		if (url.host === "127.0.0.1:4303") throw new Error("connection refused");
		return Response.json({ trace_id: traceId, attempts: [] });
	});
	expect(read.status).toBe("ok");
	expect(read.coverage).toEqual({
		hubs: 2,
		ok: 1,
		degraded: 1,
		by_hub: { nas: "ok", desktop: "unavailable" },
	});
	expect(read.peers.map((p) => [p.hub_id, p.status])).toEqual([
		["nas", "ok"],
		["desktop", "unavailable"],
	]);
});
