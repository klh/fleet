export function traceModelFetch(
	originalFetch: typeof fetch,
	front: string,
	model: string,
	started: number,
): typeof fetch {
	let requestCount = 0;
	return (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== front || !url.pathname.endsWith("/chat/completions"))
			return originalFetch(input, init);
		const reqId = ++requestCount,
			start = performance.now();
		const log = (event: string, fields: object) =>
			console.log(
				JSON.stringify({
					event,
					reqId,
					elapsedMs: Math.round(performance.now() - started),
					...fields,
				}),
			);
		try {
			const raw =
				typeof init?.body === "string"
					? init.body
					: await new Request(
							input instanceof Request ? input.clone() : input,
							init,
						).text();
			const request = JSON.parse(raw);
			const sdkCap =
				request.max_tokens ?? request.max_completion_tokens ?? null;
			const sdkCapField =
				request.max_tokens !== undefined
					? "max_tokens"
					: request.max_completion_tokens !== undefined
						? "max_completion_tokens"
						: null;
			if (request.model === model) {
				delete request.max_tokens;
				delete request.max_completion_tokens;
				init = { ...init, body: JSON.stringify(request) };
			}
			log("model-request", {
				sdkCap,
				sdkCapField,
				providerDefault: "unverified",
				model: request?.model,
				messages: request?.messages?.length,
				bodyBytes:
					typeof init?.body === "string" ? Buffer.byteLength(init.body) : null,
				max: request?.max_tokens ?? request?.max_completion_tokens,
				maxField:
					request?.max_tokens !== undefined
						? "max_tokens"
						: request?.max_completion_tokens !== undefined
							? "max_completion_tokens"
							: null,
				thinking: request?.thinking?.type ?? null,
				effort: request?.reasoning_effort ?? null,
				stream: request?.stream,
			});
			const requestHeaders = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			);
			requestHeaders.delete("content-length");
			const response = await originalFetch(input, {
				...init,
				headers: requestHeaders,
			});
			log("model-headers", {
				status: response.status,
				ms: Math.round(performance.now() - start),
				requestId: response.headers.get("x-klh-request-id"),
				traceId: response.headers.get("x-klh-trace-id"),
			});
			if (!response.body) return response;
			const reader = response.body.getReader(),
				decoder = new TextDecoder();
			let cancelled = false;
			let buffer = "",
				chunks = 0,
				bytes = 0,
				firstContent = false,
				firstTool = false,
				stopReason: string | null = null;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const item = await reader.read();
						if (cancelled) return;
						if (!item.done) {
							chunks++;
							bytes += item.value.length;
							if (chunks === 1)
								log("model-first-byte", {
									ms: Math.round(performance.now() - start),
								});
						}
						buffer += item.done
							? decoder.decode()
							: decoder.decode(item.value, { stream: true });
						const lines = buffer.split("\n");
						buffer = item.done ? "" : (lines.pop() ?? "");
						if (buffer.length > 1048576) throw Error("Oversized SSE frame");
						for (const line of lines) {
							if (!line.startsWith("data:")) continue;
							try {
								const frame = JSON.parse(line.slice(5));
								if (frame.error)
									log("model-stream-error", {
										code: frame.error.code ?? frame.error.type ?? null,
									});
								for (const choice of frame.choices ?? []) {
									if (choice.finish_reason) stopReason = choice.finish_reason;
									if (!firstContent && choice.delta?.content) {
										firstContent = true;
										log("model-first-content", {
											ms: Math.round(performance.now() - start),
										});
									}
									if (!firstTool && choice.delta?.tool_calls?.length) {
										firstTool = true;
										log("model-first-tool", {
											ms: Math.round(performance.now() - start),
										});
									}
								}
								if (frame.usage) log("model-usage", { usage: frame.usage });
							} catch {}
						}
						if (item.done) {
							log("model-end", {
								ms: Math.round(performance.now() - start),
								chunks,
								bytes,
								stopReason,
							});
							controller.close();
						} else controller.enqueue(item.value);
					} catch (error) {
						log("model-read-error", {
							name: error instanceof Error ? error.name : "unknown",
						});
						controller.error(error);
					}
				},
				cancel(reason) {
					cancelled = true;
					log("model-cancel", {});
					return reader.cancel(reason);
				},
			});
			const headers = new Headers(response.headers);
			headers.delete("content-length");
			headers.delete("content-encoding");
			return new Response(stream, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		} catch (error) {
			log("model-fetch-error", {
				name: error instanceof Error ? error.name : "unknown",
			});
			throw error;
		}
	}) as typeof fetch;
}
