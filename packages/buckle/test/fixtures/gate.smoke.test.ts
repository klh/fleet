// smoke: the shared gate fixture starts, issues, answers, tears down
import { expect, test } from "bun:test";
import { chat, issueViaAdmin, ROOT, startGate } from "./gate.ts";
import { startMockUpstream } from "../mock.ts";

test("gate fixture: health, key issue, chat proxy, teardown", async () => {
	const upstream = await startMockUpstream(() =>
		Response.json({ id: "smoke-1", choices: [], usage: {} }),
	);
	const gate = await startGate({
		upstreamUrl: upstream.url,
		auth: { rootKey: ROOT },
	});
	try {
		expect((await fetch(`${gate.base}/health`)).status).toBe(200);
		const { key } = await issueViaAdmin(gate.base, {
			name: "smoke",
			scopes: ["buckle:proxy:WRITE_"],
		});
		expect((await chat(gate.base, key)).status).toBe(200);
		const anon = await chat(gate.base, null);
		expect(anon.status).toBe(401);
	} finally {
		gate.stop();
		upstream.close();
	}
});
