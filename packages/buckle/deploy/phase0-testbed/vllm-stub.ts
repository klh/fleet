// deploy/phase0-testbed/vllm-stub.ts — deterministic OpenAI-compatible
// stand-in for the Phase 0 rehearsal (C380/C382/C384): the contract surface
// a real vLLM serves, with none of the model. Surface: GET /v1/models,
// POST /v1/chat/completions (JSON + SSE), GET /__log (rehearsal journal).
//
// Contract notes the tests pin:
// - Bearer auth is real: a wrong or missing key is a 401
//   invalid_request_error/invalid_api_key — the first hop rehearses denial,
//   not trust.
// - SSE follows OpenAI semantics: paced `chat.completion.chunk` frames, and
//   a terminal usage frame (choices: []) ONLY when the caller sent
//   stream_options.include_usage. The inner Buckle always injects
//   include_usage on streamed chat completions, so a through-gate streamed
//   request MUST produce the usage frame — the stub journal records
//   `include_usage` per request so the injection is provable, not assumed.
// - The journal records the request id headers EXACTLY as received (null
//   when absent, never synthesized): a client-forged id reaching the stub
//   proves a hop failed to strip it.
// - Content is deterministic ("stub-ok") — no model, no weights, no
//   network beyond the loopback it serves on.

export interface StubLogEntry {
	/** 1-based arrival order. */
	n: number;
	iso: string;
	method: string;
	path: string;
	/** sha256-16hex of the bearer token, null when absent. */
	keyFp: string | null;
	/** x-klh-request-id or x-request-id exactly as received, null when absent. */
	requestId: string | null;
	stream: boolean;
	/** stream_options.include_usage as received. */
	includeUsage: boolean;
	/** Content chunks emitted (0 for JSON responses). */
	chunks: number;
	/** SSE pacing actually applied, ms. */
	pacedMs: number;
}

export interface VllmStub {
	url: string;
	port: number;
	model: string;
	token: string;
	/** Rehearsal journal, oldest first. */
	log(): StubLogEntry[];
	resetLog(): void;
	stop(): Promise<void>;}

export interface VllmStubOptions {
	/** Fixed port (compose/testbed); omit for an ephemeral loopback port. */
	port?: number;
	/** Bearer the stub accepts. Default "test-stub-token". */
	token?: string;
	/** Served model id. Default "test-model". */
	model?: string;
}

const sha16 = (input: string): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return [...hasher.digest().slice(0, 8)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

const clamp = (value: number, lo: number, hi: number): number =>
	Math.min(hi, Math.max(lo, value));

export function startVllmStub(opts: VllmStubOptions = {}): VllmStub {
	const token = opts.token ?? "test-stub-token";
	const model = opts.model ?? "test-model";
	const entries: StubLogEntry[] = [];
	let counter = 0;

	const record = (
		req: Request,
		body: Record<string, unknown> | null,
		chunks: number,
		pacedMs: number,
	): void => {
		const auth = req.headers.get("authorization");
		const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
		entries.push({
			n: ++counter,
			iso: new Date().toISOString(),
			method: req.method,
			path: new URL(req.url).pathname,
			keyFp: bearer ? sha16(bearer) : null,
			requestId:
				req.headers.get("x-klh-request-id") ??
				req.headers.get("x-request-id"),
			stream: body?.stream === true,
			includeUsage:
				(body?.stream_options as Record<string, unknown> | undefined)
					?.include_usage === true,
			chunks,
			pacedMs,
		});
	};

	const usage = (promptTokens: number, completionTokens: number) => ({
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
	});

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port ?? 0,
		async fetch(req) {
			const url = new URL(req.url);
			const auth = req.headers.get("authorization");
			const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

			// The journal face is namespaced and unauthenticated by design —
			// it exists so the rehearsal can read what the stub SAW.
			if (url.pathname === "/__log")
				return Response.json({ model, entries });

			const deny = () => {
				record(req, null, 0, 0);
				return Response.json(
					{
						error: {
							message:
								"Incorrect API key provided. Check your API key.",
							type: "invalid_request_error",
							code: "invalid_api_key",
						},
					},
					{ status: 401 },
				);
			};

			if (url.pathname === "/v1/models") {
				if (bearer !== token) return deny();
				record(req, null, 0, 0);
				return Response.json({
					object: "list",
					data: [
						{
							id: model,
							object: "model",
							created: 1700000000,
							owned_by: "phase0-testbed",
						},
					],
				});
			}

			if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
				if (bearer !== token) return deny();
				const body = (await req.json().catch(() => null)) as Record<
					string,
					unknown
				> | null;
				if (!body || body.model !== model) {
					record(req, body, 0, 0);
					return Response.json(
						{
							error: {
								message: `The model \`${body?.model}\` does not exist.`,
								type: "invalid_request_error",
								code: "model_not_found",
							},
						},
						{ status: 404 },
					);
				}

				const id = `chatcmpl-stub-${counter + 1}`;
				const created = 1700000000;
				const messages = Array.isArray(body.messages) ? body.messages : [];
				const promptTokens = 8 + messages.length * 4;
				const streaming = body.stream === true;

				if (!streaming) {
					const completionTokens = 4;
					record(req, body, 0, 0);
					return Response.json({
						id,
						object: "chat.completion",
						created,
						model,
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "stub-ok",
								},
								finish_reason: "stop",
							},
						],
						usage: usage(promptTokens, completionTokens),
					});
				}

				const includeUsage =
					(body.stream_options as Record<string, unknown> | undefined)
						?.include_usage === true;
				const chunkCount = clamp(
					Math.round(Number(body.max_tokens ?? 16) / 8) || 1,
					1,
					4,
				);
				const pacedMs = clamp(Number(body.pace_ms ?? 40) || 0, 0, 2000);
				const frame = (payload: Record<string, unknown>): Uint8Array =>
					new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);

				const stream = new ReadableStream({
					async start(controller) {
						for (let i = 0; i < chunkCount; i++) {
							await Bun.sleep(pacedMs);
							controller.enqueue(
								frame({
									id,
									object: "chat.completion.chunk",
									created,
									model,
									choices: [
										{
											index: 0,
											delta: { content: "stub-ok" },
											finish_reason: null,
										},
									],
								}),
							);
						}
						await Bun.sleep(pacedMs);
						if (includeUsage) {
							controller.enqueue(
								frame({
									id,
									object: "chat.completion.chunk",
									created,
									model,
									choices: [],
									usage: usage(promptTokens, chunkCount * 4),
								}),
							);
						}
						controller.enqueue(
							new TextEncoder().encode("data: [DONE]\n\n"),
						);
						controller.close();
						record(req, body, chunkCount, pacedMs);
					},
				});
				return new Response(stream, {
					status: 200,
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
					},
				});
			}

			return Response.json(
				{ error: { message: `Not found: ${url.pathname}` } },
				{ status: 404 },
			);
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port ?? opts.port ?? 0,
		model,
		token,
		log: () => [...entries],
		resetLog: () => {
			entries.length = 0;
		},
		stop: () => {
			server.stop(true);
			return Promise.resolve();
		},
	};
}
