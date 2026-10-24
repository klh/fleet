// test/e2e-chatgpt-bridge.test.ts — W1124.27 ACTUAL local HTTP regression:
// the engine fixture enforces the live-probed ChatGPT codex contract (2026-10-23
// probes against chatgpt/gpt-6-sol via :4100 — leading string system/developer
// 200, leading block-valued 400, mid-turn system 400, mid-turn developer 400,
// tools 200 with a real function_call). A client body the native bridge
// refuses must arrive at the engine in the native-supported shape; tools ride
// verbatim; non-chatgpt groups keep verbatim passthrough.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { type MockUpstream, startMockUpstream } from "./mock.ts";

const PRIOR_LITELLM_KEY = process.env.LITELLM_KEY;
const ENGINE_KEY = "litellm-master-key-fixture";
process.env.LITELLM_KEY = ENGINE_KEY;
afterAll(() => {
	if (PRIOR_LITELLM_KEY === undefined) delete process.env.LITELLM_KEY;
	else process.env.LITELLM_KEY = PRIOR_LITELLM_KEY;
});

const CHAT = "/v1/chat/completions";
const CHATGPT_MODEL = "chatgpt/gpt-6-sol";
const CHATGPT_REFUSAL =
	'ChatgptException - {"detail":"System messages are not allowed"}';

/** Live-probed codex contract: system/developer beyond a leading STRING run
 *  is refused, exactly as the real backend refused it today. */
const codexRefusal = (body: Record<string, unknown> | null): boolean => {
	const messages = body?.messages;
	if (!Array.isArray(messages)) return false;
	// Mirrors installed LiteLLM's leading_system_count, not a broader
	// system/developer run. A developer goes into input and ends extraction.
	let leadingSystems = true;
	let inputItems = 0;
	for (const raw of messages) {
		const m = raw as Record<string, unknown>;
		if (m.role === "system") {
			if (!leadingSystems || typeof m.content !== "string") return true;
		} else {
			leadingSystems = false;
			inputItems++;
		}
	}
	// transform_request moves all-system instructions back into input when
	// no other input remains; the backend rejects this system-role item too.
	return messages.length > 0 && inputItems === 0;
};

// ─── fixtures ───────────────────────────────────────────────────────────────

/** LiteLLM chatgpt-row stand-in: master-key bearer auth, enforces the live
 *  codex contract (400 ChatgptException on refusal shapes), answers the
 *  native tool canary with a real function_call. */
async function startChatgptEngineFixture(): Promise<{ up: MockUpstream }> {
	const up = await startMockUpstream((_req, body) => {
		if (_req.headers.get("authorization") !== `Bearer ${ENGINE_KEY}`)
			return Response.json(
				{ error: { message: "Unauthorized" } },
				{ status: 401 },
			);
		if (codexRefusal(body))
			return Response.json(
				{ error: { message: CHATGPT_REFUSAL } },
				{ status: 400 },
			);
		const tools = body?.tools;
		const message = Array.isArray(tools)
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_canary_1",
							type: "function",
							function: { name: "ping", arguments: "{}" },
						},
					],
				}
			: { role: "assistant", content: "OK" };
		return Response.json({
			id: "engine-1",
			model: body?.model,
			choices: [{ index: 0, message, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 4 },
		});
	});
	return { up };
}

const UPSTREAMS_DOC = (engine: string, fallback: string): string =>
	JSON.stringify({
		version: 1,
		groups: {
			"chatgpt/gpt-6-sol": [
				{
					url: engine,
					dialect: "openai",
					adapter: "openai-compat",
					model: "chatgpt/gpt-6-sol",
					api_key_env: "LITELLM_KEY",
				},
				{
					url: fallback,
					dialect: "openai",
					adapter: "openai-compat",
					model: "plain-gpt",
				},
			],
		},
	});

const POLICY_DOC = JSON.stringify({
	version: 1,
	gateway: {
		num_retries: 1,
		allowed_fails: 50,
		cooldown_time: 60,
	},
});

const chatCalls = (up: MockUpstream) => up.calls.filter((c) => c.path === CHAT);

interface Gate {
	base: string;
	stop(): void;
}

/** One gate over a two-rung pool: the codex-contract engine fixture first
 *  (the native chatgpt rung), a plain openai-compat rung second — the
 *  honest-fallback posture. allowed_fails 50: the refuse path must never
 *  bench the rung (refusal is pre-fetch, zero engine calls). */
async function startGate(
	engine: MockUpstream,
	fallback: MockUpstream,
): Promise<Gate> {
	const dir = mkdtempSync(join(tmpdir(), "buckle-chatgpt-"));
	const upstreams = `${dir}/upstreams.json`;
	const policy = `${dir}/policy.json`;
	const prefs = `${dir}/prefs.json`;
	await Bun.write(upstreams, UPSTREAMS_DOC(engine.url, fallback.url));
	await Bun.write(policy, POLICY_DOC);
	await Bun.write(prefs, JSON.stringify({ cost_speed: "balanced" }));
	const server = startServer({
		port: 0,
		upstreamsPath: upstreams,
		policyPath: policy,
		prefsPath: prefs,
		dbPath: `${dir}/buckle.db`,
		auth: { rootKey: "buckle-chatgpt-root" },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer buckle-chatgpt-root` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
}

type ChatOut = {
	choices: Array<{
		message?: {
			content?: string;
			tool_calls?: Array<{ function?: { name?: string } }>;
		};
	}>;
};

async function startFallbackFixture(): Promise<MockUpstream> {
	return startMockUpstream(() =>
		Response.json({
			id: "fallback-1",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "fallback" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		}),
	);
}

describe("W1124.27 chatgpt native bridge regression", () => {
	test("engine fixture enforces the live codex contract: raw unsafe body 400s", async () => {
		const { up } = await startChatgptEngineFixture();
		try {
			const res = await fetch(`${up.url}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${ENGINE_KEY}` },
				body: JSON.stringify({
					model: CHATGPT_MODEL,
					messages: [
						{
							role: "system",
							content: [{ type: "text", text: "be brief" }],
						},
						{ role: "user", content: "hi" },
					],
				}),
			});
			expect(res.status).toBe(400);
			const err = (await res.json()) as { error: { message: string } };
			expect(err.error.message).toContain("System messages are not allowed");
		} finally {
			up.close();
		}
	});

	test("gate normalizes the leading block system; native tool canary delivered", async () => {
		const engine = await startChatgptEngineFixture();
		const control = await startFallbackFixture();
		const gate = await startGate(engine.up, control);
		try {
			const key = await issueViaAdmin(gate.base, {
				name: "lane",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const res = await fetch(`${gate.base}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: CHATGPT_MODEL,
					messages: [
						{
							role: "system",
							content: [{ type: "text", text: "be brief" }],
						},
						{ role: "user", content: "hi" },
					],
					tools: [
						{ type: "function", function: { name: "ping", parameters: {} } },
					],
				}),
			});
			expect(res.status).toBe(200);
			const out = (await res.json()) as ChatOut;
			expect(out.choices[0]?.message?.tool_calls?.[0]?.function?.name).toBe(
				"ping",
			);
			expect(chatCalls(engine.up)).toHaveLength(1);
			const sent = (chatCalls(engine.up)[0]?.body ?? {}) as {
				messages?: Array<{ content?: unknown }>;
			};
			expect(sent.messages?.[0]?.content).toBe("be brief");
		} finally {
			gate.stop();
			engine.up.close();
			control.close();
		}
	});

	test("mid-turn system typed-refuses the chatgpt rung; fallback rung gets the body verbatim", async () => {
		const engine = await startChatgptEngineFixture();
		const control = await startFallbackFixture();
		const gate = await startGate(engine.up, control);
		try {
			const key = await issueViaAdmin(gate.base, {
				name: "lane",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const midTurn = [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "hi" },
				{ role: "system", content: "new rule" },
			];
			const res = await fetch(`${gate.base}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: CHATGPT_MODEL,
					messages: midTurn,
				}),
			});
			expect(res.status).toBe(200);
			const out = (await res.json()) as ChatOut;
			expect(out.choices[0]?.message?.content).toBe("fallback");
			expect(chatCalls(engine.up)).toHaveLength(0);
			const fb = (chatCalls(control)[0]?.body ?? {}) as {
				messages?: unknown[];
			};
			expect(fb.messages).toEqual(midTurn);
		} finally {
			gate.stop();
			engine.up.close();
			control.close();
		}
	});
});

test.each([
	[
		"developer/system",
		[
			{ role: "developer", content: "A" },
			{ role: "system", content: "B" },
			{ role: "user", content: "hi" },
		],
	],
	[
		"system/developer/system",
		[
			{ role: "system", content: "A" },
			{ role: "developer", content: "B" },
			{ role: "system", content: "C" },
			{ role: "user", content: "hi" },
		],
	],
	["all system strings", [{ role: "system", content: "A" }]],
	["all system", [{ role: "system", content: [{ type: "text", text: "A" }] }]],
])(
	"native-unsupported %s is skipped BEFORE fetch and falls back verbatim",
	async (_name, messages) => {
		const engine = await startChatgptEngineFixture(),
			control = await startFallbackFixture();
		const gate = await startGate(engine.up, control);
		try {
			const body = { model: CHATGPT_MODEL, messages };
			const raw = await fetch(`${engine.up.url}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${ENGINE_KEY}` },
				body: JSON.stringify(body),
			});
			expect(raw.status).toBe(400);
			const key = await issueViaAdmin(gate.base, {
				name: "ordering-regression",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const response = await fetch(`${gate.base}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			expect(
				((await response.json()) as ChatOut).choices[0]?.message?.content,
			).toBe("fallback");
			expect(chatCalls(engine.up)).toHaveLength(1); // only the deliberate raw negative, no gate fetch
			expect(chatCalls(control)[0]?.body?.messages).toEqual(messages);
		} finally {
			gate.stop();
			engine.up.close();
			control.close();
		}
	},
);
