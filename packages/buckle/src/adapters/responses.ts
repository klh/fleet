// src/adapters/responses.ts — the Responses-wire family (W2583): providers
// that serve ONLY the OpenAI Responses wire (GitHub Copilot's gpt/grok/mai
// rows carry supported_endpoints [/responses] and NO /v1/messages — a
// chat-shaped rung can never serve them). The wire leg is always
// /v1/responses; the bridge tier owns the body translation (chat→Responses
// in bridge.ts via chatToResponses), so buildCall is a pure pass-through
// builder: model alias patch, no stream_options (a chat knob the Responses
// wire refuses). The response leg re-frames back to the client wire in the
// router seam (router-attempt.ts → bridgeResponsesUpstream).
import type { UpstreamRequest } from "../router.ts";
import type { Deployment } from "../upstreams.ts";
import { usageFromOpenAI } from "../usage.ts";
import { normalizeUpstreamError } from "./errors.ts";
import {
	bearerHeaders,
	type ChatAdapter,
	type WireCall,
	upstreamUrlOf,
	usageField,
} from "./types.ts";

export const OPENAI_RESPONSES: ChatAdapter = {
	family: "openai-responses",
	dialect: "openai",
	caps: { countTokens: false, tools: false, streamOptions: false },

	async buildCall(
		dep: Deployment,
		req: UpstreamRequest,
		body: Record<string, unknown>,
	): Promise<WireCall> {
		const wire: Record<string, unknown> = {
			...body,
			model: dep.model ?? body.model,
		};
		delete wire.stream_options; // a chat knob the Responses wire refuses
		return {
			url: upstreamUrlOf(dep, req.path),
			headers: bearerHeaders(dep),
			body: JSON.stringify(wire),
		};
	},
	parseResponse: (_dep, wire) => wire,
	normalizeError: (status, wire, headers) =>
		normalizeUpstreamError("openai-compat", status, wire, headers),
	usageOf: (wire) => usageFromOpenAI(usageField(wire)),
};
