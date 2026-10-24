// test/adapters-wire.test.ts — tier-1 wire fixtures (in-test Bun.serve
// mocks per W134 §4.3) + registry fail-closed + the upstreams `adapter:`
// field (derive-from-dialect back-compat, unknown = startup fatal).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ANTHROPIC } from "../src/adapters/anthropic.ts";
import { getAdapter, resolveAdapter } from "../src/adapters/index.ts";
import { OPENAI_COMPAT } from "../src/adapters/openai-compat.ts";
import { loadUpstreams } from "../src/upstreams.ts";
import { defaultFetch } from "../src/wire.ts";
import { startMockUpstream } from "./mock.ts";

const OPENAI_REQ = {
	group: "g",
	dialect: "openai" as const,
	path: "/v1/chat/completions",
	body: {
		model: "alias",
		stream: true,
		stream_options: { foo: 1 },
		messages: [],
	},
	key: "",
};

describe("registry (fail closed)", () => {
	test("five families resolve; unknown names fail closed", () => {
		expect(getAdapter("openai-compat").family).toBe("openai-compat");
		expect(getAdapter("anthropic").dialect).toBe("anthropic");
		// W150: tier-2 ports landed — they resolve through the registry
		expect(getAdapter("azure-openai").family).toBe("azure-openai");
		expect(getAdapter("bedrock").family).toBe("bedrock");
		expect(getAdapter("vertex").family).toBe("vertex");
		expect(() =>
			resolveAdapter({ adapter: "nope", dialect: "openai" }),
		).toThrow(/unknown adapter/);
	});

	test("caps per W134 §5.3 + identity parseResponse", () => {
		expect(OPENAI_COMPAT.caps).toEqual({
			countTokens: false,
			tools: true,
			streamOptions: true,
		});
		expect(ANTHROPIC.caps).toEqual({
			countTokens: true,
			tools: true,
			streamOptions: false,
		});
		const wire = { id: "x" };
		const dep = { group: "g", url: "", dialect: "openai" as const };
		expect(OPENAI_COMPAT.parseResponse(dep, wire)).toBe(wire);
		expect(ANTHROPIC.parseResponse(dep, wire)).toBe(wire);
	});
});

describe("upstreams adapter field", () => {
	test("derive-from-dialect back-compat + explicit override", async () => {
		const upstream = await startMockUpstream(() => Response.json({ ok: true }));
		const dir = `/tmp/buckle-adapters-${Date.now()}-${process.pid}`;
		const cfg = JSON.stringify({
			groups: {
				g1: [{ url: upstream.url, dialect: "openai" }],
				g2: [
					{ url: upstream.url, dialect: "openai", adapter: "openai-compat" },
				],
			},
		});
		await Bun.write(`${dir}/upstreams.json`, cfg);
		const pool = loadUpstreams(`${dir}/upstreams.json`);
		expect(pool.deployments("g1")[0]?.adapter).toBe("openai-compat");
		expect(pool.deployments("g2")[0]?.adapter).toBe("openai-compat");
		upstream.close();
	});

	test("unknown adapter = startup fatal naming the group", async () => {
		const dir = `/tmp/buckle-adapters-${Date.now()}-${process.pid}`;
		const cfg = JSON.stringify({
			groups: {
				bad: [
					{
						url: "http://127.0.0.1:9",
						dialect: "openai",
						adapter: "frobnicate",
					},
				],
			},
		});
		await Bun.write(`${dir}/upstreams.json`, cfg);
		expect(() => loadUpstreams(`${dir}/upstreams.json`)).toThrow(/group "bad"/);
	});
});

describe("tier-2 family named in config (W150)", () => {
	test("bedrock named in config loads; resolution is deferred to request time", () => {
		const dir = `/tmp/buckle-adapters-${Date.now()}-${process.pid}`;
		const cfg = JSON.stringify({
			groups: {
				aws: [
					{
						url: "http://127.0.0.1:9",
						dialect: "openai",
						adapter: "bedrock",
					},
				],
			},
		});
		const p = `${dir}/u.json`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(p, cfg);
		const pool = loadUpstreams(p);
		const dep = pool.deployments("aws")[0];
		expect(dep?.adapter).toBe("bedrock");
	});
});

describe("openai-compat buildCall (request fixtures)", () => {
	test("model patch + include_usage injection", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "openai" as const,
			model: "real-model",
		};
		await defaultFetch(dep, OPENAI_REQ, 5000);
		const sent = upstream.calls[0];
		expect(sent?.path).toBe("/v1/chat/completions");
		expect(sent?.body).toEqual({
			model: "real-model",
			stream: true,
			stream_options: { foo: 1, include_usage: true },
			messages: [],
		});
		expect(sent?.auth).toBe(null);
		upstream.close();
	});

	test("bearer auth from api_key_env", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "openai" as const,
			api_key_env: "W139_TEST_KEY",
		};
		process.env.W139_TEST_KEY = "sk-w139-test";
		try {
			await defaultFetch(dep, { ...OPENAI_REQ, body: { model: "m" } }, 5000);
		} finally {
			delete process.env.W139_TEST_KEY;
		}
		expect(upstream.calls[0]?.auth).toBe("Bearer sk-w139-test");
		upstream.close();
	});

	test("W695.6 adapter_config.headers ride the wire; authorization stays env-only", async () => {
		const dep = {
			group: "g",
			url: "https://api.githubcopilot.com",
			dialect: "anthropic" as const,
			model: "claude-sonnet-5.5",
			api_key_env: "W695_TEST_KEY",
			adapter_config: {
				headers: {
					"Copilot-Integration-Id": "vscode-chat",
					authorization: "Bearer attacker",
					bad: 7,
				},
			},
		};
		process.env.W695_TEST_KEY = "seat-token";
		const body = { model: "claude-sonnet-5", max_tokens: 1 };
		const req = { ...OPENAI_REQ, dialect: "anthropic" as const, body };
		try {
			const wire = await ANTHROPIC.buildCall(dep, req, body);
			expect(wire.headers["copilot-integration-id"]).toBe("vscode-chat");
			expect(wire.headers.authorization).toBe("Bearer seat-token");
			expect(wire.headers.bad).toBeUndefined();
			expect(JSON.parse(wire.body).model).toBe("claude-sonnet-5.5");
		} finally {
			delete process.env.W695_TEST_KEY;
		}
	});
});

describe("upstreamUrlOf path rewrite (W935)", () => {
	test("path_rewrite moves only the pathname; unlisted paths stay verbatim", async () => {
		const dep = {
			group: "g",
			url: "https://api.githubcopilot.com",
			dialect: "openai" as const,
			adapter_config: {
				path_rewrite: { "/v1/chat/completions": "/chat/completions" },
			},
		};
		const wire = await OPENAI_COMPAT.buildCall(
			dep,
			OPENAI_REQ,
			OPENAI_REQ.body,
		);
		expect(wire.url).toBe("https://api.githubcopilot.com/chat/completions");
		// /v1/responses is not listed → verbatim (it IS served with /v1)
		const responses = await OPENAI_COMPAT.buildCall(
			dep,
			{ ...OPENAI_REQ, path: "/v1/responses" },
			{ model: "m" },
		);
		expect(responses.url).toBe("https://api.githubcopilot.com/v1/responses");
	});

	test("invalid path_rewrite values fail closed to verbatim", async () => {
		const dep = {
			group: "g",
			url: "https://api.githubcopilot.com",
			dialect: "anthropic" as const,
			adapter_config: {
				path_rewrite: {
					"/v1/messages": "chat/completions",
					"/v1/messages/count_tokens": 7,
				},
			} as unknown as Record<string, string>,
		};
		const wire = await ANTHROPIC.buildCall(
			dep,
			{ ...OPENAI_REQ, dialect: "anthropic" as const, path: "/v1/messages" },
			{ model: "m" },
		);
		// non-absolute / non-string values are dropped → verbatim forward
		expect(wire.url).toBe("https://api.githubcopilot.com/v1/messages");
	});
});

describe("anthropic buildCall", () => {
	test("model patch, no stream_options on the anthropic wire", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "msg_1" }),
		);
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "anthropic" as const,
			model: "claude-real",
		};
		await defaultFetch(
			dep,
			{
				...OPENAI_REQ,
				dialect: "anthropic" as const,
				path: "/v1/messages",
				body: { model: "alias", stream: true },
			},
			5000,
		);
		const sent = upstream.calls[0];
		expect(sent?.path).toBe("/v1/messages");
		expect(sent?.body).toEqual({ model: "claude-real", stream: true });
		upstream.close();
	});
});

describe("cache-control passthrough (W457)", () => {
	test("anthropic cache_control breakpoints reach the wire byte-intact", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "msg_1" }),
		);
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "anthropic" as const,
			model: "claude-real",
		};
		const body = {
			model: "alias",
			stream: true,
			system: [
				{
					type: "text",
					text: "stable starter prefix",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{ role: "user", content: "lane material after the checkpoint" },
			],
		};
		await defaultFetch(
			dep,
			{ ...OPENAI_REQ, path: "/v1/messages", body },
			5000,
		);
		// the model alias patch is the ONLY allowed mutation — cache_control
		// breakpoints and every other field arrive byte-intact
		expect(upstream.calls[0]?.body).toEqual({ ...body, model: "claude-real" });
		upstream.close();
	});

	test("openai cache-eligible fields reach the wire byte-intact", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const dep = {
			group: "g",
			url: upstream.url,
			dialect: "openai" as const,
			model: "real-model",
		};
		const body = {
			model: "alias",
			stream: true,
			messages: [
				{ role: "system", content: "stable prefix for prompt caching" },
				{ role: "user", content: "lane material" },
			],
			prompt_cache_key: "starter-v3",
		};
		await defaultFetch(dep, { ...OPENAI_REQ, body }, 5000);
		// model patch + include_usage injection are the ONLY allowed mutations
		// — prompt-cache-eligible messages + prompt_cache_key arrive untouched
		expect(upstream.calls[0]?.body).toEqual({
			...body,
			model: "real-model",
			stream_options: { include_usage: true },
		});
		upstream.close();
	});
});

describe("usageOf per family", () => {
	test("each adapter reads its own usage shape", () => {
		expect(
			OPENAI_COMPAT.usageOf({
				usage: { prompt_tokens: 2, completion_tokens: 3 },
			}),
		).toEqual({ in_tok: 2, out_tok: 3, cache_r: 0, cache_c: 0 });
		expect(
			ANTHROPIC.usageOf({
				usage: {
					input_tokens: 5,
					output_tokens: 0,
					cache_read_input_tokens: 1,
				},
			}),
		).toEqual({ in_tok: 5, out_tok: 0, cache_r: 1, cache_c: 0 });
		expect(OPENAI_COMPAT.usageOf({})).toBe(null);
	});
});
