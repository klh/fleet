// test/federation-board-page.test.ts — W171: the /federation-usage board
// dashboard — degrade-honest without env, renders the W152 chrome with
// real hub rollups when configured (server-side fetch, browser never sees
// the key).
import { describe, expect, test } from "bun:test";
import { handleFederationUsage } from "../hooks/board/routes-federation.ts";
import { startServer } from "../../buckle/src/server.ts";

const ROOT = "buckle-test-root";

async function optInHub(): Promise<{ base: string; stop: () => void }> {
	const dir = `/tmp/w171-page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  federation:",
		"    self_report:",
		"      teams: [platform]",
		"",
	].join("\n");
	await Bun.write(`${dir}.policy.yaml`, policy);
	await Bun.write(
		`${dir}.upstreams.yaml`,
		"version: 1\ngroups:\n  local-swarm:\n    - url: http://127.0.0.1:8502\n      dialect: openai\n",
	);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.yaml`,
		upstreamsPath: `${dir}.upstreams.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${String(srv.port)}`,
		stop: () => srv.stop(true),
	};
}

describe("federation board page", () => {
	test("degrades honestly without env", async () => {
		const url = new URL("http://board/federation-usage");
		const res = await handleFederationUsage(new Request(url), url);
		expect(res === null).toBe(false);
		if (res === null) return;
		const html = await res.text();
		expect(html).toContain("FEDERATED USAGE");
		expect(html).toContain("not set on the board host");
	});

	test("renders hub rollups when configured", async () => {
		const hub = await optInHub();
		try {
			const mint = async (): Promise<string> => {
				const r = await fetch(`${hub.base}/v1/admin/keys`, {
					method: "POST",
					headers: { authorization: `Bearer ${ROOT}` },
					body: JSON.stringify({
						name: "board-test",
						scopes: ["buckle:spoke:WRITE_", "buckle:spoke:READ_"],
					}),
				});
				return (await r.json()).key;
			};
			const spokeKey = await mint();
			await fetch(`${hub.base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${spokeKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					team: "platform",
					windows: [
						{
							bucket: (Math.floor(Date.now() / 3_600_000) - 1) * 3_600_000,
							classes: {
								flash: {
									in_tok: 1000,
									out_tok: 400,
									cache_r: 60,
									cache_c: 5,
									requests: 7,
								},
								local: {
									in_tok: 200,
									out_tok: 90,
									cache_r: 0,
									cache_c: 0,
									requests: 2,
								},
							},
							aids: [
								{
									aid: "lesson-recall",
									domain: "knowledge",
									injected: 4,
									skipped: 2,
									tok_injected: 1800,
								},
							],
						},
					],
				}),
			}).then((r) => expect(r.status).toBe(200));
			const prev = {
				FEDERATION_HUB_URL: process.env.FEDERATION_HUB_URL,
				FEDERATION_HUB_TOKEN: process.env.FEDERATION_HUB_TOKEN,
			};
			process.env.FEDERATION_HUB_URL = hub.base;
			process.env.FEDERATION_HUB_TOKEN = ROOT;
			try {
				const url = new URL("http://board/federation-usage?days=7");
				const res = await handleFederationUsage(new Request(url), url);
				if (res === null) throw new Error("route returned null");
				const html = await res.text();
				expect(html).toContain("FEDERATED USAGE");
				expect(html).toContain("spoke-");
			} finally {
				if (prev.FEDERATION_HUB_URL === undefined)
					delete process.env.FEDERATION_HUB_URL;
				else process.env.FEDERATION_HUB_URL = prev.FEDERATION_HUB_URL;
				if (prev.FEDERATION_HUB_TOKEN === undefined)
					delete process.env.FEDERATION_HUB_TOKEN;
				else process.env.FEDERATION_HUB_TOKEN = prev.FEDERATION_HUB_TOKEN;
			}
		} finally {
			hub.stop();
		}
	});
});
