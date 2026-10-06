#!/usr/bin/env bun
// ~/.claude/local-llm/anthropic-shim.ts — minimal Anthropic↔OpenAI shim for
// LOCAL models (replaces the litellm experimental bridge, which hard-routes
// through the OpenAI Responses API). Translates POST /v1/messages to the
// MLX server's /v1/chat/completions. ~90 lines, no framework, no deps.
//   bun anthropic-shim.ts            # serves :4000, backend :8901
import { livenessResponse } from "./health.ts";

interface ShimBody {
	model?: string;
	max_tokens?: number;
	temperature?: number;
	messages?: { role?: string; content?: string | { text?: string }[] }[];
}
interface BackendReply {
	choices?: {
		finish_reason?: string;
		message?: { content?: string; reasoning_content?: string };
	}[];
	error?: { message?: string };
}

const PORT = Number(process.env.SHIM_PORT ?? 4000);
const BACKEND = process.env.MLX_BASE ?? "http://localhost:8901";

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const health = livenessResponse(req, "belt-anthropic-shim");
		if (health) return health;
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			url.pathname === "/v1/models"
		) {
			try {
				const response = await fetch(`${BACKEND}/v1/models`, {
					signal: AbortSignal.timeout(2000),
					redirect: "manual",
				});
				if (!response.ok) {
					await response.body?.cancel();
					return Response.json(
						{ error: "backend unavailable" },
						{ status: 503, headers: { "cache-control": "no-store" } },
					);
				}
				if (req.method === "HEAD") await response.body?.cancel();
				return new Response(req.method === "HEAD" ? null : response.body, {
					headers: {
						"content-type": "application/json",
						"cache-control": "no-store",
					},
				});
			} catch {
				return Response.json(
					{ error: "backend unavailable" },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			}
		}
		if (req.method !== "POST" || url.pathname !== "/v1/messages")
			return Response.json({ error: "not found" }, { status: 404 });

		let body: ShimBody;
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400 });
		}

		const messages = (body.messages ?? []).map((m) => {
			const content =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content.map((b) => b.text ?? "").join("")
						: "";
			return { role: m.role === "assistant" ? "assistant" : "user", content };
		});

		let text = "";
		let stop = "";
		try {
			const r = await fetch(`${BACKEND}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model:
						body.model?.replace(/\[1m\]$/, "") === "glm-5.2" ||
						body.model?.startsWith("glm-")
							? (Bun.env.MLX_MODEL ?? "mlx-community/Qwen3-4B-4bit")
							: body.model,
					messages,
					max_tokens: Math.min(body.max_tokens ?? 1024, 4096),
					temperature: body.temperature ?? 0.7,
					stream: false,
					chat_template_kwargs: { enable_thinking: false },
				}),
			});
			const j: BackendReply = await r.json();
			const msg = j.choices?.[0]?.message ?? {};
			text =
				(msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() ||
				(msg.reasoning_content || "")
					.replace(/<think>[\s\S]*?<\/think>/g, "")
					.trim();
			stop =
				j.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn";
			if (!r.ok || !text)
				throw new Error(
					j.error?.message ??
						`backend ${r.status}: ${JSON.stringify(j).slice(0, 200)}`,
				);
		} catch (e) {
			return Response.json(
				{
					type: "error",
					error: {
						type: "api_error",
						message: `shim: ${e instanceof Error ? e.message : String(e)}`,
					},
				},
				{ status: 502 },
			);
		}

		// Anthropic response shape (what claude -p consumes)
		return Response.json({
			id: `msg_local_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content: [{ type: "text", text }],
			stop_reason: stop,
			usage: { input_tokens: 0, output_tokens: 0 },
		});
	},
});
console.log(`anthropic-shim on :${PORT} → ${BACKEND}`);
