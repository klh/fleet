// deploy/e2e/stub-tier.ts — the belt tier stand-in for docker e2e (W234).
// The swarm specialists are MLX (Apple-silicon-only), so a container chain
// runs cpu-mode: this stub serves the SAME wire contract the routing ladder
// targets (OpenAI /v1/chat/completions on :8902, streaming + JSON) with a
// canned completion. A chat whose reply carries the marker
// ("e2e-stub-ok") proves the full serving chain: caller → buckle gate →
// ladder → this tier → response. Harness fixture, never deployed.

const PORT = Number(process.env.TIER_PORT ?? 8902);
const MARKER = "e2e-stub-ok";

interface ChatBody {
	model?: string;
	stream?: boolean;
	messages?: Array<{ role: string; content: string }>;
}

/** One canned OpenAI completion body — echoes the requested model. */
function completion(model: string): Record<string, unknown> {
	return {
		id: `chatcmpl-e2e-${Date.now().toString(36)}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: MARKER },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
	};
}

/** SSE stream of chat.completion.chunk frames + [DONE] — the shape the
 *  belt specialists emit and buckle's openai-compat adapter consumes. */
function streamBody(model: string): Response {
	const enc = new TextEncoder();
	const frame = (delta: Record<string, unknown>, last: boolean): Uint8Array =>
		enc.encode(
			`data: ${JSON.stringify({
				id: "chatcmpl-e2e-stream",
				object: "chat.completion.chunk",
				model,
				choices: [{ index: 0, delta, finish_reason: last ? "stop" : null }],
			})}\n\n`,
		);
	const body = new ReadableStream({
		start(controller): void {
			controller.enqueue(frame({}, false));
			controller.enqueue(frame({ role: "assistant" }, false));
			controller.enqueue(frame({ content: MARKER }, false));
			controller.enqueue(frame({}, true));
			controller.enqueue(enc.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

const server = Bun.serve({
	hostname: "0.0.0.0",
	port: PORT,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/healthz") return new Response("ok");
		if (pathname === "/status")
			return Response.json({ service: "belt-stub-tier", up: true, port: PORT });
		if (pathname === "/v1/models")
			return Response.json({
				data: [{ id: "glm-5.3-flash" }, { id: "local-swarm" }],
			});
		if (req.method === "POST" && pathname === "/v1/chat/completions") {
			return req
				.json()
				.then((body: ChatBody) =>
					body.stream === true
						? streamBody(body.model ?? "glm-5.3-flash")
						: Response.json(completion(body.model ?? "glm-5.3-flash")),
				)
				.catch(() => new Response("bad body", { status: 400 }));
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(
	`belt-stub-tier: canned OpenAI tier on http://0.0.0.0:${server.port}`,
);
