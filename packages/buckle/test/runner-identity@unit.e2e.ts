import { expect, test } from "@playwright/test";
import { chat, issueViaAdmin, ROOT, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

test("runner identity remains live while model admission is occupied @unit", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const upstream = await startMockUpstream(async () => {
		await blocked;
		return Response.json({ id: "held", choices: [], usage: {} });
	});
	const gate = await startGate({
		upstreamUrl: upstream.url,
		slots: { global: 1, perTeam: 0 },
	});
	let pending: Promise<Response> | undefined;
	try {
		const { key, keyId } = await issueViaAdmin(gate.base, {
			name: "runner-control",
			scopes: ["buckle:proxy:WRITE_", "buckle:runner:WRITE_"],
		});
		pending = chat(gate.base, key);
		const generations = () =>
			upstream.calls.filter((call) => call.path === "/v1/chat/completions");
		await expect.poll(() => generations().length).toBe(1);
		expect((await chat(gate.base, key)).status).toBe(429);
		const identify = () =>
			fetch(`${gate.base}/v1/fleet/whoami`, {
				headers: { authorization: `Bearer ${key}` },
			});
		const identity = await identify();
		expect(identity.status).toBe(200);
		expect((await identity.json()).key_id).toBe(keyId);
		expect(generations()).toHaveLength(1);
		expect((await fetch(`${gate.base}/v1/fleet/whoami`)).status).toBe(401);
		const denied = await issueViaAdmin(gate.base, {
			name: "no-proxy",
			scopes: ["buckle:runner:WRITE_"],
		});
		expect(
			(
				await fetch(`${gate.base}/v1/fleet/whoami`, {
					headers: { authorization: `Bearer ${denied.key}` },
				})
			).status,
		).toBe(403);
		await fetch(`${gate.base}/v1/admin/keys/${keyId}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
		});
		expect((await identify()).status).toBe(401);
	} finally {
		release();
		await pending;
		gate.stop();
		upstream.close();
	}
});
