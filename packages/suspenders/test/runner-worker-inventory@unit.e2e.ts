import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "@klh/buckle/src/server.ts";
import { scratchWorld } from "@klh/test-kit";
import { fetchHubWorkers } from "../hooks/coord/workers.ts";
import { createRunnerIdentity } from "../hooks/lib/runners/api/identity.ts";
import { stashPrincipal } from "@klh/buckle/src/gov/federation.ts";
import { createApp } from "@klh/buckle/src/wire-routes.ts";
import { workerInventoryRelay } from "@klh/buckle/src/worker-inventory.ts";
import { expect, test } from "@playwright/test";
import { getLease, revokeLease } from "../hooks/lib/runners/control/leases.ts";
import { recordWorkerHeartbeat } from "../hooks/lib/runners/control/worker-heartbeat.ts";
import { apiWorld } from "./runner-api.fixture.ts";

test("Buckle relays only owner-visible current worker inventory @unit", async () => {
	const world = apiWorld();
	try {
		const runId = crypto.randomUUID();
		expect((await world.request("alice", "/runs", { runId, profile: "standard" })).status).toBe(201);
		expect((await world.request("alice", `/runs/${runId}/submit`, {
			text: "fixture", requestId: crypto.randomUUID(),
		})).status).toBe(200);
		const lease = getLease(world.store, runId);
		if (!lease) throw new Error("fixture lease missing");
		const identity = { runId, controllerSid: lease.controller_sid, epoch: lease.epoch };
		const now = Date.now();
		expect(recordWorkerHeartbeat(world.store, identity, { state: "running" }, now, now - 60_000)).toBe(true);
		const relay = workerInventoryRelay("http://127.0.0.1:7810", Object.assign(
			async (_url, init) => world.fetch(new Request("http://localhost:7810/v1/workers", init)),
			{ preconnect: () => {} },
		));
		// Only this exact route is exercised; unrelated gateway dependencies are unused.
		const app = createApp({ workerInventory: relay } as Parameters<typeof createApp>[0]);
		const read = (keyId, scopes = ["buckle:runner:READ_"]) => {
			const req = new Request("http://localhost/v1/workers", {
				headers: { authorization: `Bearer ${keyId}` },
			});
			stashPrincipal(req, { keyId, scopes, kind: "api_key", name: null, actor: null, team: null, jti: null, rpm: null, tpm: null });
			return app.fetch(req);
		};
		expect((await app.fetch(new Request("http://localhost/v1/workers"))).status).toBe(401);
		expect((await read("alice", [])).status).toBe(403);
		expect((await (await read("bob")).json()).workers).toEqual([]);
		expect((await (await read("alice")).json()).workers).toMatchObject([{ sid: runId, rights: ["read-only"] }]);
		revokeLease(world.store, runId, now + 1);
		expect(recordWorkerHeartbeat(world.store, identity, { state: "running" }, now + 2, now - 60_000)).toBe(false);
		expect((await (await read("alice")).json()).workers).toEqual([]);
	} finally {
		world.close();
	}
});

test("coord inventory crosses real Buckle authentication and a loopback runner @unit", async () => {
	const scratch = scratchWorld({ prefix: "runner-inventory-wire-" });
	let world;
	let gateway;
	let gatewayUrl = "";
	let inventoryReads = 0;
	const runner = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/v1/workers") inventoryReads++;
			return world.fetch(request);
		},
	});
	try {
		const upstreamsPath = join(scratch.home, "upstreams.json");
		await Bun.write(upstreamsPath, JSON.stringify({ groups: { fixture: [{ url: "http://127.0.0.1:1", dialect: "openai" }] } }));
		const accountPolicyPath = join(scratch.home, "account-policy.json");
		await Bun.write(accountPolicyPath, JSON.stringify({ version: 1, classes: [] }));
		const rootKey = crypto.randomUUID();
		gateway = startServer({ port: 0, hostname: "127.0.0.1", dbPath: ":memory:", upstreamsPath, accountPolicyPath, auth: { rootKey }, runnerInventoryOrigin: runner.url.origin });
		gatewayUrl = gateway.url.origin;
		world = apiWorld({
			allowedHosts: [runner.url.host, "localhost:7810"],
			identity: createRunnerIdentity({ baseUrl: gatewayUrl }),
		});
		const mint = async (name) => {
			const response = await fetch(new URL("/v1/admin/keys", gatewayUrl), {
				method: "POST", headers: { authorization: `Bearer ${rootKey}`, "content-type": "application/json" },
				body: JSON.stringify({ name, scopes: ["buckle:proxy:READ_", "buckle:runner:WRITE_"] }),
			});
			expect(response.ok).toBe(true);
			return response.json();
		};
		const owner = await mint("fixture-owner");
		const other = await mint("fixture-other");
		const runId = crypto.randomUUID();
		expect((await world.request(owner.key, "/runs", { runId, profile: "standard" })).status).toBe(201);
		expect((await world.request(owner.key, `/runs/${runId}/submit`, { text: "fixture", requestId: crypto.randomUUID() })).status).toBe(200);
		const lease = getLease(world.store, runId);
		if (!lease) throw new Error("fixture lease missing");
		const binding = { runId, controllerSid: lease.controller_sid, epoch: lease.epoch };
		const now = Date.now();
		const body = { state: "running" };
		for (const invalid of [{ ...binding, runId: crypto.randomUUID() }, { ...binding, controllerSid: "other" }, { ...binding, epoch: binding.epoch + 1 }])
			expect(recordWorkerHeartbeat(world.store, invalid, body, now, now - 60_000)).toBe(false);
		expect(recordWorkerHeartbeat(world.store, binding, body, now, now - 60_000)).toBe(true);
		const ownerToken = join(scratch.home, "owner.key");
		const otherToken = join(scratch.home, "other.key");
		writeFileSync(ownerToken, owner.key, { mode: 0o600 });
		writeFileSync(otherToken, other.key, { mode: 0o600 });
		expect(await fetchHubWorkers(gatewayUrl, ownerToken)).toMatchObject([{ sid: runId }]);
		expect(await fetchHubWorkers(gatewayUrl, otherToken)).toEqual([]);
		expect(inventoryReads).toBe(2);
		expect((await fetch(new URL(`/v1/admin/keys/${owner.key_id}/revoke`, gatewayUrl), {
			method: "POST", headers: { authorization: `Bearer ${rootKey}` },
		})).ok).toBe(true);
		expect(await fetchHubWorkers(gatewayUrl, ownerToken)).toBeNull();
		expect(inventoryReads).toBe(2);
	} finally {
		gateway?.stop(true);
		runner.stop(true);
		world?.close();
		scratch.clean();
	}
});
