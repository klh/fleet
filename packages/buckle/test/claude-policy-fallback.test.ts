import { describe, expect, test } from "bun:test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

function poolOf(claude: Deployment[], glm: Deployment[]): UpstreamPool {
	return {
		groups: () => ["claude-sonnet-5", "glm-5.3-flash"],
		deployments: (group) =>
			group === "claude-sonnet-5"
				? claude
				: group === "glm-5.3-flash"
					? glm
					: [],
	};
}

const message = (url: string) =>
	new Request(`${url}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-5",
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					name: "lookup",
					description: "Look up",
					input_schema: { type: "object" },
				},
			],
		}),
	});

const glmAnswer = () =>
	Response.json({
		id: "chat-fallback",
		model: "zai-glm-5.3-flash",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "ready" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 8, completion_tokens: 1 },
	});

describe("configured Claude to GLM fallback", () => {
	for (const status of [429, 502]) {
		test(`a ${status} Claude reply falls through to GLM with model and trace visible`, async () => {
			const claude = await startMockUpstream(() =>
				Response.json(
					{
						type: "error",
						error: { type: "overloaded_error", message: "busy" },
					},
					{
						status,
						headers: status === 429 ? { "retry-after": "996295" } : {},
					},
				),
			);
			const glm = await startMockUpstream(() => glmAnswer());
			try {
				const d = testDeps(
					poolOf(
						[
							{
								group: "claude-sonnet-5",
								url: claude.url,
								dialect: "anthropic",
							},
						],
						[
							{
								group: "glm-5.3-flash",
								url: glm.url,
								dialect: "openai",
								model: "zai-glm-5.3-flash",
							},
						],
					),
					{
						policy: {
							num_retries: status === 429 ? 1 : 0,
							fallbacks: { "claude-sonnet-5": ["glm-5.3-flash"] },
						},
						prefs: { cost_speed: "balanced", allow_cloud: true },
						sleepMs: async () => {
							if (status === 429) throw new Error("quota wall must not sleep");
						},
					},
				);
				const res = await createApp(d).fetch(message(claude.url));
				expect(res.status).toBe(200);
				const route = JSON.parse(res.headers.get("x-belt-route") ?? "{}");
				expect(route.decision).toBe("fallback");
				expect(route.target.model).toBe("zai-glm-5.3-flash");
				expect(route.rid).toBe(res.headers.get("x-belt-rid"));
				expect(claude.calls).toHaveLength(1);
				expect(glm.calls).toHaveLength(1);
				expect(glm.calls[0]?.body?.model).toBe("zai-glm-5.3-flash");
				expect(glm.calls[0]?.body?.tools).toBeDefined();
				const body = (await res.json()) as { content: Array<{ text: string }> };
				expect(body.content[0]?.text).toBe("ready");
			} finally {
				claude.close();
				glm.close();
			}
		});
	}

	test("missing Claude deployment selects only the configured GLM fallback", async () => {
		const glm = await startMockUpstream(() => glmAnswer());
		try {
			const d = testDeps(
				poolOf(
					[],
					[
						{
							group: "glm-5.3-flash",
							url: glm.url,
							dialect: "openai",
							model: "zai-glm-5.3-flash",
						},
					],
				),
				{
					policy: {
						num_retries: 0,
						fallbacks: { "claude-sonnet-5": ["glm-5.3-flash"] },
					},
					prefs: { cost_speed: "balanced", allow_cloud: true },
				},
			);
			const res = await createApp(d).fetch(message(glm.url));
			expect(res.status).toBe(200);
			const route = JSON.parse(res.headers.get("x-belt-route") ?? "{}");
			expect(route.decision).toBe("fallback");
			expect(route.target.model).toBe("zai-glm-5.3-flash");
		} finally {
			glm.close();
		}
	});
});
