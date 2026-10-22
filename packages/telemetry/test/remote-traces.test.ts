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
						duration_ms: 23,
						retry_after_ms: 5000,
						call_id: "call-1",
						provider_pool: "account",
						queue_wait_ms: 123,
						body: "secret prompt",
					},
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
						retry_after_ms: 5000,
						provider_pool: "account",
						queue_wait_ms: 123,
					},
				],
			},
		],
	});
	expect(JSON.stringify(read)).not.toContain("secret prompt");
	expect(JSON.stringify(read)).not.toContain("private-admin-read-key");
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
		peers: [{ hub_id: "zai", status: "unavailable", attempts: [] }],
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
