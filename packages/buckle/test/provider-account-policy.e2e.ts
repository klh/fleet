import { expect, test } from "@playwright/test";
import { defaultAccountPolicy } from "../src/account-policy.ts";
import { stashPrincipal } from "../src/gov/federation.ts";
import type { Principal } from "../src/gov/middleware.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

const principal: Principal = {
	kind: "api_key",
	keyId: "test-key",
	name: "any-tool-key",
	team: null,
	actor: "any-tool-key",
	scopes: ["buckle:proxy:WRITE_*"],
	jti: null,
	rpm: null,
	tpm: null,
};

function request(url: string): Request {
	const req = new Request(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "glm-5.3",
			messages: [{ role: "user", content: "hi" }],
		}),
	});
	stashPrincipal(req, principal);
	return req;
}

test("Z.ai provider identity admits its openai-compat row and excludes a foreign row", async () => {
	const zai = await startMockUpstream(() =>
		Response.json({
			id: "zai-response",
			choices: [{ message: { content: "ok" } }],
		}),
	);
	const foreign = await startMockUpstream(() =>
		Response.json({ id: "foreign-response" }),
	);
	try {
		const pool: UpstreamPool = {
			groups: () => ["glm-5.3"],
			deployments: (group) => [
				{
					group,
					url: foreign.url,
					dialect: "openai",
					adapter: "openai-compat",
					provider: "github_copilot",
					priority: 0,
				},
				{
					group,
					url: zai.url,
					dialect: "openai",
					adapter: "openai-compat",
					provider: "zai",
					priority: 1,
				},
			],
		};
		const app = createApp(
			testDeps(pool, { accountPolicy: defaultAccountPolicy().doc }),
		);
		const response = await app.fetch(request(zai.url));
		expect(response.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(foreign.calls.length).toBe(0);
	} finally {
		zai.close();
		foreign.close();
	}
});

test("scoped refusal prefixes detail with provider and leaves stable code unchanged", async () => {
	const zai = await startMockUpstream(() =>
		Response.json({ id: "unexpected" }),
	);
	try {
		const pool: UpstreamPool = {
			groups: () => ["glm-5.3"],
			deployments: (group) => [
				{
					group,
					url: zai.url,
					dialect: "openai",
					adapter: "openai-compat",
					provider: "zai",
				},
			],
		};
		const accountPolicy = {
			version: 1,
			classes: [
				{
					id: "other",
					tier: "other",
					general: true,
					keys: ["*"],
					providers: ["openrouter"],
				},
			],
		};
		const app = createApp(testDeps(pool, { accountPolicy }));
		const response = await app.fetch(request(zai.url));
		expect(response.status).toBe(503);
		const problem = (await response.json()) as { code: string; detail: string };
		expect(problem.code).toBe("buckle.tier_no_upstream");
		expect(problem.detail.startsWith("belt: zai.buckle.tier_no_upstream")).toBe(
			true,
		);
		expect(zai.calls.length).toBe(0);
	} finally {
		zai.close();
	}
});
