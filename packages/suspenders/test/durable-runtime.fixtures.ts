import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { z } from "zod";

const Args = z.strictObject({ value: z.literal("ok") });

/** Deterministic protocol fixture; its synthetic usage is never benchmark evidence. */
export function createFixtureRuntime(url: string, effect: () => Promise<void>) {
	const models = createModels(),
		baseUrl = `${url}/v1`;
	models.setProvider(
		createProvider({
			id: "fixture",
			baseUrl,
			auth: {
				apiKey: {
					name: "Fixture",
					resolve: async () => ({ auth: { apiKey: "fixture-key" } }),
				},
			},
			models: [
				{
					id: "fixture",
					name: "Fixture",
					provider: "fixture",
					api: "openai-completions",
					baseUrl,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 200,
				},
			],
			api: openAICompletionsApi(),
		}),
	);
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "fixture",
			tools: [
				defineTool({
					name: "probe",
					description: "Fixture probe",
					parameters: z.toJSONSchema(Args),
					replay: "unsafe",
					async execute(raw) {
						Args.parse(raw);
						await effect();
						return { output: [{ type: "text", text: "ok" }] };
					},
				}),
			],
		}),
	);
	return {
		models,
		registry,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	};
}

export function fixtureResponse(n: number): Response {
	const delta =
		n === 1
			? {
					tool_calls: [
						{
							index: 0,
							id: "call-fixture",
							type: "function",
							function: { name: "probe", arguments: '{"value":"ok"}' },
						},
					],
				}
			: { content: "done" };
	const chunks = [
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{
			choices: [
				{ index: 0, delta: {}, finish_reason: n === 1 ? "tool_calls" : "stop" },
			],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		},
	];
	return new Response(
		`${chunks.map((c) => `data: ${JSON.stringify({ id: `fixture-${n}`, object: "chat.completion.chunk", created: 1, model: "fixture", ...c })}\n\n`).join("")}data: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}
