import { expect, test } from "@playwright/test";
import { chat, issueViaAdmin, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

test("control credential can verify identity but cannot generate model tokens @unit", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json({ choices: [] }),
	);
	const gate = await startGate({ upstreamUrl: upstream.url });
	try {
		const { key, keyId } = await issueViaAdmin(gate.base, {
			name: "runner-control-only",
			scopes: ["buckle:runner:WRITE_", "buckle:proxy:READ_"],
		});
		const identity = await fetch(`${gate.base}/v1/fleet/whoami`, {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(identity.status).toBe(200);
		expect((await identity.json()).key_id).toBe(keyId);
		expect((await chat(gate.base, key)).status).toBe(403);
		expect(
			upstream.calls.filter((call) => call.path === "/v1/chat/completions"),
		).toHaveLength(0);
	} finally {
		gate.stop();
		upstream.close();
	}
});
