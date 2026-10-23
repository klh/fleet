// router-sse.ts — SSE wire translation: OpenAI chat-completions → Anthropic
// event-stream, chunk by chunk (no buffering). <think> stripping rides the
// text path; W789 tool-call blocks and W257 server timings ride the relay.
// Extracted from router-core.ts (W1238.6.1); router-core re-exports the
// public names so the router-core face stays stable.
import type { RequestTimings } from "./router-core.ts";
import {
	emptyStreamError,
	StreamSemantics,
} from "../../buckle/src/stream-semantics.ts";
import { upstreamErrorDetail } from "../../buckle/src/error-detail.ts";
/** Drops <think>…</think> spans across chunk boundaries. */
export function thinkFilter(): (chunk: string) => string {
	let inThink = false;
	let carry = "";
	return (chunk) => {
		let s = carry + chunk;
		carry = "";
		let out = "";
		for (;;) {
			const tag = inThink ? "</think>" : "<think>";
			const i = s.indexOf(tag);
			if (i >= 0) {
				if (!inThink) out += s.slice(0, i);
				s = s.slice(i + tag.length);
				inThink = !inThink;
				continue;
			}
			// hold back a possible partial tag at the end
			let keep = 0;
			for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
				if (tag.startsWith(s.slice(s.length - k))) {
					keep = k;
					break;
				}
			}
			if (!inThink) out += s.slice(0, s.length - keep);
			carry = s.slice(s.length - keep);
			return out;
		}
	};
}

const sseEvent = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STOP_REASON: Record<string, string> = {
	length: "max_tokens",
	stop: "end_turn",
	tool_calls: "tool_use",
};
export const stopReason = (finish?: string): string =>
	(finish && STOP_REASON[finish]) || "end_turn";

export interface StreamMeta {
	id: string;
	model: string | undefined;
	routing?: Record<string, unknown>;
	/** W257: t0 = performance.now() at request receipt; openedAt = upstream
	 *  open; timings = pre-measured (buffered legs). With startedAt set the
	 *  tail's message_delta usage carries `_server_timings`. */
	startedAt?: number;
	openedAt?: number;
	timings?: RequestTimings;
}

function anthropicHead(meta: StreamMeta): string {
	return (
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: meta.id,
				type: "message",
				role: "assistant",
				model: meta.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
				...(meta.routing ? { _routing: meta.routing } : {}),
			},
		}) +
		sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})
	);
}

/** message_delta + message_stop (the tail after the last content block). */
function messageTail(
	stop: string | undefined,
	outTokens: number,
	timings?: RequestTimings,
): string {
	return (
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stop ?? "end_turn", stop_sequence: null },
			usage: {
				output_tokens: outTokens,
				...(timings ? { _server_timings: timings } : {}),
			},
		}) + sseEvent("message_stop", { type: "message_stop" })
	);
}

function anthropicTail(
	finish: string | undefined,
	outTokens: number,
	timings?: RequestTimings,
): string {
	return (
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
		messageTail(stopReason(finish), outTokens, timings)
	);
}

const textDelta = (text: string) =>
	sseEvent("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});

/** A buffered answer (cloud escalation, fallback) as an Anthropic SSE stream,
 *  so stream:true clients always get the wire they asked for. */
export function anthropicSseFromText(
	text: string,
	meta: StreamMeta,
	finish?: string,
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			c.enqueue(
				enc.encode(
					anthropicHead(meta) +
						textDelta(text) +
						anthropicTail(finish, 0, meta.timings),
				),
			);
			c.close();
		},
	});
}

interface OpenAiChunk {
	error?: unknown;
	choices?: Array<{
		delta?: {
			content?: string | null;
			/** W789: streaming tool calls — accumulated per OpenAI index. */
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: { completion_tokens?: number };
}

/** Translate an OpenAI chat-completions SSE body into Anthropic SSE, piping
 *  chunk by chunk (no buffering). `onDone` fires once with the totals. */
export function anthropicSseFromOpenAi(
	upstream: ReadableStream<Uint8Array>,
	meta: StreamMeta,
	onDone: (r: {
		chars: number;
		finish?: string;
		error?: string;
		timings?: RequestTimings;
	}) => void = () => {},
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const filter = thinkFilter();
	const semantics = new StreamSemantics();
	let buf = "";
	let chars = 0;
	let finish: string | undefined;
	let sourceFailure: string | undefined;
	let outTokens = 0;
	let finished = false;
	let ttftAt: number | undefined;
	// W789: anthropic block indices — 0 is the text block opened by the head;
	// each OpenAI tool index gets its own tool_use block from 1 up.
	const toolAcc = new Map<
		number,
		{ id: string; name: string; started: boolean }
	>();
	let blockIndex = 0;
	let textClosed = false;
	/** W257: `_server_timings` from t0/openedAt + the first-token mark; absent
	 *  (not zero) when the meta carries no t0. */
	const composeTimings = (): RequestTimings | undefined => {
		if (meta.startedAt === undefined) return undefined;
		const endAt = performance.now();
		return {
			total_ms: Math.round(endAt - meta.startedAt),
			prefill_ms: Math.round((meta.openedAt ?? endAt) - meta.startedAt),
			ttft_ms:
				ttftAt === undefined ? undefined : Math.round(ttftAt - meta.startedAt),
			decode_ms: ttftAt === undefined ? undefined : Math.round(endAt - ttftAt),
		};
	};
	const done = (error?: string, timings?: RequestTimings) => {
		if (finished) return;
		finished = true;
		onDone({ chars, finish, error, timings: timings ?? composeTimings() });
	};
	const handleLine = (line: string): string => {
		if (sourceFailure) return "";
		if (!line.startsWith("data:")) return "";
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return "";
		let j: OpenAiChunk;
		try {
			j = JSON.parse(data);
		} catch {
			return "";
		}
		if (j.error != null) {
			const error = upstreamErrorDetail(j);
			sourceFailure = String(error.code ?? error.type);
			return sseEvent("error", { type: "error", error });
		}
		if (j.usage?.completion_tokens) outTokens = j.usage.completion_tokens;
		const ch = j.choices?.[0];
		if (ch?.finish_reason) finish = ch.finish_reason;
		const tcs = ch?.delta?.tool_calls;
		if (tcs && tcs.length > 0) {
			const out: string[] = [];
			for (const tc of tcs) {
				const idx = tc.index ?? 0;
				let acc = toolAcc.get(idx);
				if (!acc) {
					acc = {
						id: tc.id ?? `call_${idx}`,
						name: tc.function?.name ?? "",
						started: false,
					};
					toolAcc.set(idx, acc);
				}
				if (tc.id) acc.id = tc.id;
				if (tc.function?.name) acc.name = tc.function.name;
				if (!acc.started) {
					if (!textClosed) {
						out.push(
							sseEvent("content_block_stop", {
								type: "content_block_stop",
								index: 0,
							}),
						);
						textClosed = true;
					}
					blockIndex += 1;
					acc.started = true;
					semantics.observe(
						{ content_block: { type: "tool_use", name: acc.name } },
						"anthropic",
					);
					out.push(
						sseEvent("content_block_start", {
							type: "content_block_start",
							index: blockIndex,
							content_block: {
								type: "tool_use",
								id: acc.id,
								name: acc.name,
								input: {},
							},
						}),
					);
				}
				if (tc.function?.arguments) {
					out.push(
						sseEvent("content_block_delta", {
							type: "content_block_delta",
							index: blockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: tc.function.arguments,
							},
						}),
					);
				}
			}
			return out.join("");
		}
		const text = filter(ch?.delta?.content ?? "");
		if (!text) return "";
		if (textClosed) return ""; // text after tool blocks: dropped (wire order)
		if (ttftAt === undefined) ttftAt = performance.now();
		chars += text.length;
		semantics.observe({ delta: { text } }, "anthropic");
		return textDelta(text);
	};
	const reader = upstream.getReader();
	// W278: after cancel() the controller is closed — a pump enqueue throws,
	// the catch enqueues again, and that second throw escapes the void async
	// as an unhandled rejection (shim died on client aborts). One flag,
	// checked before every controller call.
	let clientGone = false;
	return new ReadableStream({
		start(c) {
			c.enqueue(enc.encode(anthropicHead(meta)));
			// PUSH-based: pump inside start() — Bun 1.4.x serve does not drive
			// pull()-based ReadableStream responses (verified 2026-10-03: pull()
			// never fires after start(); push-style pumping streams fine).
			void (async () => {
				try {
					for (;;) {
						const { value, done: eof } = await reader.read();
						if (clientGone) return;
						if (eof) {
							const timings = composeTimings();
							const last = handleLine(buf);
							semantics.observe(
								{ delta: { stop_reason: stopReason(finish) } },
								"anthropic",
							);
							if (sourceFailure) {
								if (!clientGone) {
									if (last) c.enqueue(enc.encode(last));
									c.close();
								}
								done(sourceFailure, timings);
								return;
							}
							const failure = semantics.failure();
							if (failure) {
								if (!clientGone) {
									c.enqueue(
										enc.encode(
											last +
												sseEvent("error", {
													type: "error",
													error: emptyStreamError(failure),
												}),
										),
									);
									c.close();
								}
								done(failure, timings);
								return;
							}
							let tail = anthropicTail(finish, outTokens, timings);
							if (toolAcc.size > 0) {
								if (!textClosed)
									tail =
										sseEvent("content_block_stop", {
											type: "content_block_stop",
											index: 0,
										}) + tail;
								// close the last tool block before the message tail
								tail =
									sseEvent("content_block_stop", {
										type: "content_block_stop",
										index: blockIndex,
									}) + tail;
							}
							const out = last + tail;
							if (!clientGone) {
								c.enqueue(enc.encode(out));
								c.close();
							}
							done();
							return;
						}
						buf += dec.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() ?? "";
						const out = lines.map(handleLine).join("");
						if (out && !clientGone) c.enqueue(enc.encode(out));
						if (sourceFailure) {
							if (!clientGone) c.close();
							done(sourceFailure);
							await reader.cancel("upstream source error").catch(() => {});
							return;
						}
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (!clientGone) {
						c.enqueue(
							enc.encode(
								sseEvent("error", {
									type: "error",
									error: {
										type: "api_error",
										message: `router: upstream stream broke (${msg})`,
									},
								}),
							),
						);
						c.close();
					}
					done(msg);
				}
			})();
		},
		async cancel(reason) {
			clientGone = true;
			try {
				await reader.cancel(reason);
			} finally {
				done("client cancelled");
			}
		},
	});
}
