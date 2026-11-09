import { SseSniffer } from "@klh/buckle/src/sse.ts";
import { z } from "zod";

const FrameSchema = z
	.object({
		model: z.string().optional(),
		choices: z
			.array(
				z
					.object({
						delta: z
							.object({ content: z.string().nullish() })
							.loose()
							.optional(),
					})
					.loose(),
			)
			.optional(),
	})
	.loose();

/** Shared wire parser supplies usage/terminal semantics; no second SSE parser. */
export async function probeStream(
	url: string,
	key: string,
	model: string,
	prompt: string,
	timeoutMs: number,
	fetchFn: typeof fetch = fetch,
) {
	const start = performance.now();
	let headersMs: number | null = null,
		firstOutputMs: number | null = null,
		firstByteMs: number | null = null;
	let content = "",
		wireModel: string | null = null,
		bytes = 0,
		malformed = false;
	const signal = AbortSignal.timeout(timeoutMs);
	const sniffer = new SseSniffer("openai", (raw) => {
		const parsed = FrameSchema.safeParse(raw);
		if (!parsed.success) {
			malformed = true;
			return;
		}
		wireModel = parsed.data.model ?? wireModel;
		for (const choice of parsed.data.choices ?? []) {
			const text = choice.delta?.content ?? "";
			if (text && firstOutputMs === null)
				firstOutputMs = performance.now() - start;
			content += text;
		}
	});
	let error: string | null = null;
	try {
		const response = await fetchFn(url, {
			method: "POST",
			signal,
			redirect: "error",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 1024,
				temperature: 0,
				stream: true,
				stream_options: { include_usage: true },
				...(/glm-5\.3/i.test(model)
					? { thinking: { type: "enabled" }, reasoning_effort: "low" }
					: {}),
			}),
		});
		headersMs = performance.now() - start;
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status}`);
		}
		for await (const chunk of response.body) {
			if (firstByteMs === null && chunk.length)
				firstByteMs = performance.now() - start;
			bytes += chunk.length;
			if (bytes > 1_000_000) throw new Error("stream byte limit");
			sniffer.push(chunk);
		}
		sniffer.flush();
		if (malformed || !sniffer.completed() || sniffer.failed())
			error = sniffer.failureKind() ?? "invalid or truncated stream";
	} catch (e) {
		error = signal.aborted
			? "deadline"
			: e instanceof Error
				? e.message
				: "transport failure";
	}
	return {
		headersMs,
		firstByteMs,
		firstOutputMs,
		wallMs: performance.now() - start,
		content,
		wireModel,
		usage: sniffer.usage(),
		cacheReported: sniffer.cacheReported(),
		timedOut: signal.aborted,
		error,
	};
}
