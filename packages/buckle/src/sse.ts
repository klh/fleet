// src/sse.ts — SSE sniffing for the usage tee. A line-oriented parser
// consuming the tee'd sniff branch of the upstream body; the client branch
// is never touched by this code (byte identity is structural: tee()).
// Usage semantics ported from LiteLLM 1.103.0 streaming_handler.py (MIT):
// extract usage even when the caller never asked — include_usage only
// controls what the caller sees; anthropic usage rides message_start
// (input side, incl. cache columns) and the cumulative output_tokens on
// message_delta. Keep-alive comment lines (`: ping`) pass through the
// client branch verbatim and are ignored here.
import type { Dialect } from "./upstreams.ts";
import {
	type EmptyStreamKind,
	EMPTY_STREAM_KINDS,
	emptyStreamError,
	StreamSemantics,
} from "./stream-semantics.ts";
import {
	cacheUsageReported,
	cacheWriteReported,
	type Usage,
	usageFromAnthropic,
	usageFromOpenAI,
} from "./usage.ts";

type AnyRec = Record<string, unknown>;

/** W1106: canonical transport keepalive — one SSE comment frame, valid on
 *  both dialects, no client-visible value (the WHATWG parser ignores `:`).
 *  Emitted wherever a transform would otherwise produce ZERO client bytes
 *  for upstream activity (ping drops, zero-event bridge chunks): clients
 *  that sensor idle sockets must see bytes to keep a live stream alive.
 *  Never masks a hung provider — the wire.ts upstream idle/total guards
 *  measure upstream chunks independently. keepalives do NOT reset
 *  Bun's server-side idleTimeout (real-Bun canary disproved that); W1106
 *  disables that timer globally (BUN_IDLE_TIMEOUT=0 in server.ts). */
export const SSE_KEEPALIVE = ": keepalive\n\n";

/** Consumes upstream SSE bytes, extracts usage. Emits nothing downstream. */
export class SseSniffer {
	private buf = "";
	private eventType = "";
	/** data: lines of the event being assembled (joined with \n at dispatch) */
	private dataLines: string[] = [];
	/** ONE streaming decoder: a multibyte char split across chunks survives */
	private readonly decoder = new TextDecoder();
	private start: Usage | null = null;
	private deltaOut = 0;
	private openai: Usage | null = null;
	private cacheSeen = false;
	private cacheWriteSeen = false;
	/** W1106: the dialect's protocol terminal was seen on this stream —
	 *  anthropic `message_stop` / openai `[DONE]`. EOF without it is a
	 *  truncation, never a completed turn. */
	private sawStop = false;
	/** W1106: an in-band failure arrived (anthropic event:error / openai
	 *  response.failed|incomplete / a non-null error object) — non-success
	 *  even when a terminal marker follows. */
	private sawError = false;
	private errorKind: string | null = null;
	/** W1267: the in-band failure's provider code ("1302", "1113", …) when
	 *  the failure frame carried one — admission pressure classification. */
	private errorCode: string | null = null;
	/** W1106 empty-stream guard: semantic observation of every data frame —
	 *  a protocol terminal WITHOUT usable output is a typed failure, not a
	 *  completed turn (the 483-byte envelope class). */
	private readonly semantics = new StreamSemantics();

	constructor(
		private readonly dialect: Dialect,
		private readonly onFrame?: (frame: unknown) => void,
	) {}

	hasUsableOutput(): boolean {
		return this.semantics.failure() === null;
	}

	/** Feed the next byte chunk. */
	push(chunk: Uint8Array | string): void {
		this.buf +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		let idx = this.buf.indexOf("\n");
		while (idx >= 0) {
			this.line(this.buf.slice(0, idx).replace(/\r$/, ""));
			this.buf = this.buf.slice(idx + 1);
			idx = this.buf.indexOf("\n");
		}
	}

	/** Final flush at stream end: decoder tail, a tail line without
	 *  trailing newline, and an event never closed by a blank line. */
	flush(): void {
		this.buf += this.decoder.decode();
		if (this.buf.length > 0) {
			this.line(this.buf.replace(/\r$/, ""));
			this.buf = "";
		}
		this.dispatch();
	}

	/** One SSE line (WHATWG event-stream field rules). */
	private line(line: string): void {
		if (line.length === 0) {
			this.dispatch(); // blank line = event boundary
			return;
		}
		if (line.startsWith(":")) return; // keep-alive comment
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.eventType = value.trim();
		else if (field === "data") this.dataLines.push(value);
	}

	/** Event boundary: join the data lines, parse, then reset event state. */
	private dispatch(): void {
		const payload = this.dataLines.join("\n").trim();
		this.dataLines = [];
		// W1106: protocol terminals — openai ends with the [DONE] sentinel
		// (chat completions) or response.completed (Responses wire, W912);
		// anthropic with a message_stop event (either framing).
		if (payload === "[DONE]") this.sawStop = true;
		else if (
			this.dialect === "openai" &&
			this.eventType === "response.completed"
		)
			this.sawStop = true;
		else if (
			this.dialect === "openai" &&
			(this.eventType === "response.failed" ||
				this.eventType === "response.incomplete")
		)
			this.markError("in_band"); // #55446: in-band failure, never completion
		else if (this.dialect === "anthropic" && this.eventType === "message_stop")
			this.sawStop = true;
		else {
			// W1106 eventless frames (data-only, no event name — bridge hops
			// that strip names, the Responses wire): the JSON type field is
			// the only terminal signal, either dialect.
			try {
				const j: unknown = payload.length > 0 ? JSON.parse(payload) : null;
				if (j && typeof j === "object") {
					const t = (j as AnyRec).type;
					if (t === "message_stop" || t === "response.completed")
						this.sawStop = true;
				}
			} catch {
				// non-JSON: not terminal-bearing
			}
		}
		try {
			if (payload.length > 0 && payload !== "[DONE]") {
				const parsed: unknown = JSON.parse(payload);
				this.onFrame?.(parsed);
				// W1106 empty-stream guard: re-mark the bridge's own typed
				// failure when it passes through a second hop (preserve the
				// semantic code, never a generic api_error), then observe.
				const err = (parsed as AnyRec).error;
				const code =
					err !== null && typeof err === "object"
						? String((err as AnyRec).code)
						: "";
				if (EMPTY_STREAM_KINDS.includes(code)) {
					this.markError(code);
					return;
				}
				this.semantics.observe(parsed, this.dialect);
				this.data(parsed);
			}
		} catch {
			// non-JSON data: not usage-bearing, ignore honestly
		}
		this.eventType = "";
	}

	/** W1106 empty-stream verdict: when the protocol terminal arrived but
	 *  NO usable assistant output was seen, this is the typed failure kind
	 *  (handlers banks it via failureKind()). Null = turn carried output. */
	private semanticFailure(): string | null {
		return this.sawStop ? this.semantics.failure() : null;
	}

	/** W1106: true once the dialect's protocol terminal was seen. */
	completed(): boolean {
		return this.sawStop;
	}

	/** W1106 (#55446/#55461): an in-band failure arrived — non-success even
	 *  when a terminal marker follows it. The empty-stream guard rides the
	 *  same verdict: a protocol terminal WITHOUT usable output is also a
	 *  failure (the 483-byte class). A REAL in-band failure outranks the
	 *  semantic one — errorKind wins when both are set. */
	failed(): boolean {
		return this.sawError || this.semanticFailure() !== null;
	}

	/** The typed in-band failure kind (null = no in-band failure seen). The
	 *  empty-stream guard folds its verdict in here — handlers.ts banks it
	 *  unchanged via streamInBand. */
	failureKind(): string | null {
		return this.errorKind ?? this.semanticFailure();
	}

	/** W1267: the provider code carried by an in-band failure frame
	 *  ("1302", "1113", …), null when no in-band failure or no code. The
	 *  admission layer classifies pressure from this code — HTTP200 streams
	 *  that end in response.failed/incomplete or an event:error frame are
	 *  refusal evidence, never healthy transport EOF. */
	inBandCode(): string | null {
		return this.sawError ? this.errorCode : null;
	}

	/** W1267: the in-band failure verdict alone — null when the stream saw
	 *  NO in-band failure frame. Kept separate from the code so admission
	 *  can refuse healthy credit for uncoded failures without inventing a
	 *  fake 429. */
	inBandFailure(): string | null {
		return this.sawError ? (this.errorKind ?? "in_band") : null;
	}

	private markError(kind: string): void {
		this.sawError = true;
		this.errorKind = kind;
	}

	private data(json: unknown): void {
		if (!json || typeof json !== "object") return;
		const r = json as AnyRec;
		// W1106 (#55446/#55461): in-band failure bodies — anthropic's
		// `{type:"error"}` event and openai error envelopes — mark the
		// stream failed REGARDLESS of any terminal marker that follows.
		if (r.type === "error") {
			const err = (r.error ?? {}) as AnyRec;
			this.markError(
				typeof err.type === "string" ? `in_band:${err.type}` : "in_band",
			);
			this.errorCode = typeof err.code === "string" ? err.code : null;
			return;
		}
		// Responses-wire failures arrive as bare data frames (no event name):
		// the JSON type field is the only signal.
		if (r.type === "response.failed" || r.type === "response.incomplete") {
			const inner = ((r.response ?? {}) as AnyRec).error as AnyRec | undefined;
			this.markError(
				inner && typeof inner.code === "string"
					? `in_band:${inner.code}`
					: "in_band",
			);
			this.errorCode =
				inner && typeof inner.code === "string" ? inner.code : null;
			return;
		}
		if (
			r.error !== undefined &&
			r.error !== null &&
			typeof r.error === "object"
		)
			this.markError("in_band");
		if (this.dialect === "anthropic") {
			const t = typeof r.type === "string" ? r.type : this.eventType;
			if (t === "message_start") {
				const msg = (r.message ?? {}) as AnyRec;
				this.cacheSeen ||= cacheUsageReported("anthropic", msg.usage);
				this.cacheWriteSeen ||= cacheWriteReported("anthropic", msg.usage);
				const u = usageFromAnthropic(msg.usage);
				if (u !== null) this.start = u;
			} else if (t === "message_delta") {
				this.cacheSeen ||= cacheUsageReported("anthropic", r.usage);
				this.cacheWriteSeen ||= cacheWriteReported("anthropic", r.usage);
				const u = usageFromAnthropic(r.usage);
				if (u !== null) {
					this.deltaOut = Math.max(this.deltaOut, u.out_tok);
					// Some bridges send input and cache usage only in the final
					// delta. Every field is cumulative, so retain its maximum.
					this.start = {
						in_tok: Math.max(this.start?.in_tok ?? 0, u.in_tok),
						out_tok: this.start?.out_tok ?? 0,
						cache_r: Math.max(this.start?.cache_r ?? 0, u.cache_r),
						cache_c: Math.max(this.start?.cache_c ?? 0, u.cache_c),
					};
				}
			}
			return;
		}
		this.cacheSeen ||= cacheUsageReported("openai", this.openaiUsageOf(r));
		const u = usageFromOpenAI(this.openaiUsageOf(r));
		if (u !== null) this.openai = u; // last chunk wins
	}

	/** The openai-family usage slot of one SSE event: top-level `usage` on
	 *  the chat-completions wire; on the Responses wire (W912) the usage
	 *  rides the response object of `response.*` events. */
	private openaiUsageOf(r: AnyRec): unknown {
		if (r.usage !== undefined && r.usage !== null) return r.usage;
		if (typeof r.type === "string" && r.type.startsWith("response.")) {
			const resp = r.response;
			if (resp !== null && typeof resp === "object")
				return (resp as AnyRec).usage;
		}
		return undefined;
	}

	/** Extracted usage, or null = honest unknown (nothing was seen). */
	usage(): Usage | null {
		if (this.dialect === "anthropic") {
			if (this.start === null && this.deltaOut === 0) return null;
			return {
				in_tok: this.start?.in_tok ?? 0,
				out_tok: Math.max(this.deltaOut, this.start?.out_tok ?? 0),
				cache_r: this.start?.cache_r ?? 0,
				cache_c: this.start?.cache_c ?? 0,
			};
		}
		return this.openai;
	}

	cacheReported(): boolean {
		return this.cacheSeen;
	}

	cacheWriteReported(): boolean {
		return this.cacheWriteSeen;
	}
}

/**
 * W616.1 — canonical SSE re-framer for the anthropic pass-through client
 * branch. Byte identity (tee()) forwarded upstream framing defects verbatim:
 * litellm's anthropic adapter emits `event: ping` keepalives during quiet
 * windows, and its ping write races the content write — the ping frame lands
 * MID-LINE inside a `data:` payload (fleet/lane-autow499 log: `data: {...,
 * "inde` + `event: ping`), the client's parser joins the corrupt data lines
 * and JSON.parse kills the lane mid-stream. This transform re-assembles
 * events with the same WHATWG framing SseSniffer uses, then re-emits each
 * one as a canonical frame. Ping events are dropped outright (keepalives,
 * no client value — the anthropic SDK treats them as no-ops). An event whose
 * data does not parse is quarantined: dropped, counted, stream kept alive —
 * one lost delta beats one dead lane. Well-framed events re-emit
 * semantically identical (multi-line data joins back per spec).
 */
export function sseReframer(
	onDrop?: (reason: "ping" | "corrupt", preview: string) => void,
	guardDialect?: Dialect,
	onFailure?: (kind: string) => void,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	// W1106 empty-stream guard (#56010): when a dialect is handed in, the
	// reframer also observes every re-assembled frame — a success terminal
	// without usable output is swapped for the typed in-band error so the
	// native client sees the failure the ledger banks.
	const guard =
		guardDialect === undefined ? null : new SseSniffer(guardDialect);
	let rejected = false;
	let terminals: string[] = [];
	let terminalBytes = 0;
	let buf = "";
	let eventType = "";
	/** data: lines of the event being assembled (joined with \n at emit) */
	let dataLines: string[] = [];

	const drop = (reason: "ping" | "corrupt", preview: string): void => {
		try {
			onDrop?.(reason, preview);
		} catch {
			// a failing observer must never break the stream
		}
	};

	/** W1106 empty-stream guard: swap a SUCCESS terminal that carried no
	 *  usable output for the dialect's typed in-band error frame. */
	const rejectEmpty = (
		c: TransformStreamDefaultController<Uint8Array>,
		kind: string,
	): void => {
		rejected = true;
		const error = emptyStreamError(kind as EmptyStreamKind);
		const body =
			guardDialect === "anthropic"
				? `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`
				: `data: ${JSON.stringify({ error })}\n\n`;
		c.enqueue(encoder.encode(body));
	};

	const dispatch = (c: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = dataLines.join("\n").trim();
		const evt = eventType;
		dataLines = [];
		eventType = "";
		if (rejected) return;
		if (evt === "ping") {
			drop("ping", payload.slice(0, 80));
			c.enqueue(encoder.encode(SSE_KEEPALIVE)); // W1106: keep the socket fed
			return;
		}
		if (payload.length === 0) {
			if (evt.length > 0) c.enqueue(encoder.encode(`event: ${evt}\n\n`));
			return;
		}
		let parsed: AnyRec | null = null;
		if (payload !== "[DONE]") {
			try {
				const j: unknown = JSON.parse(payload);
				if (j && typeof j === "object") parsed = j as AnyRec;
				if (j && typeof j === "object" && (j as AnyRec).type === "ping") {
					drop("ping", payload.slice(0, 80));
					c.enqueue(encoder.encode(SSE_KEEPALIVE)); // W1106: socket fed
					return;
				}
			} catch {
				drop("corrupt", payload.slice(0, 80));
				return;
			}
		}
		// W1106 empty-stream guard (#56010): observe the re-assembled frame;
		// a SUCCESS terminal without usable output swaps for the typed
		// in-band error. Error/failed frames pass (already failures).
		if (guard !== null) {
			guard.push(`event: ${evt}\ndata: ${payload}\n\n`);
			const frame = (body: string): string =>
				evt ? `event: ${evt}\ndata: ${body}\n\n` : `data: ${body}\n\n`;
			const hold = (body: string): boolean => {
				const encoded = frame(body);
				terminalBytes += encoder.encode(encoded).byteLength;
				if (terminalBytes > 16_384) {
					terminals = [];
					rejected = true;
					try {
						onFailure?.("stream_terminal_metadata_limit");
					} catch {
						/* observers cannot break delivery */
					}
					const error = {
						type: "api_error",
						code: "stream_terminal_metadata_limit",
						message: "Upstream terminal metadata exceeds 16 KiB",
					};
					c.enqueue(
						encoder.encode(
							guardDialect === "anthropic"
								? `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`
								: `data: ${JSON.stringify({ error })}\n\n`,
						),
					);
					return false;
				}
				terminals.push(encoded);
				return true;
			};
			// A real source error wins over any previously held success metadata.
			if (
				parsed &&
				(parsed.error != null ||
					["error", "response.failed", "response.incomplete"].includes(
						String(parsed.type),
					))
			) {
				terminals = [];
				c.enqueue(encoder.encode(frame(payload)));
				rejected = true;
				return;
			}
			if (
				terminals.length > 0 &&
				parsed &&
				((guardDialect === "anthropic" &&
					(parsed.type ?? evt) === "message_delta") ||
					(guardDialect === "openai" &&
						Array.isArray(parsed.choices) &&
						parsed.choices.length === 0 &&
						parsed.usage != null))
			) {
				hold(payload);
				return;
			}
			if (
				guardDialect === "anthropic" &&
				(parsed?.type ?? evt) === "message_delta" &&
				(parsed?.delta as AnyRec | undefined)?.stop_reason != null
			) {
				hold(payload);
				return;
			}
			if (
				guardDialect === "openai" &&
				Array.isArray(parsed?.choices) &&
				parsed.choices.some((choice: AnyRec) => choice.finish_reason != null)
			) {
				const choices = parsed.choices as AnyRec[];
				const terminal = {
					...parsed,
					choices: choices
						.filter((choice) => choice.finish_reason != null)
						.map((choice) => ({
							...choice,
							delta: {},
						})),
				};
				if (!hold(JSON.stringify(terminal))) return;
				if (
					choices.some(
						(choice) =>
							choice.finish_reason == null ||
							Object.keys((choice.delta ?? {}) as AnyRec).length > 0,
					)
				) {
					const live = {
						...parsed,
						choices: choices.map((choice) => ({
							...(choice.finish_reason == null
								? choice
								: { index: choice.index, delta: choice.delta }),
							finish_reason: null,
						})),
					};
					delete live.usage;
					c.enqueue(encoder.encode(frame(JSON.stringify(live))));
				}
				return;
			}
			// completed() covers the named terminals AND the eventless
			// type:message_stop / type:response.completed frames — one
			// verdict for every framing.
			if (guard.completed()) {
				const kind = guard.failureKind();
				if (kind !== null && EMPTY_STREAM_KINDS.includes(kind)) {
					terminals = [];
					rejectEmpty(c, kind);
					return;
				}
				for (const terminal of terminals) c.enqueue(encoder.encode(terminal));
				terminals = [];
				terminalBytes = 0;
			}
		}
		c.enqueue(
			encoder.encode(
				evt.length > 0
					? `event: ${evt}\ndata: ${payload}\n\n`
					: `data: ${payload}\n\n`,
			),
		);
	};

	const line = (
		raw: string,
		c: TransformStreamDefaultController<Uint8Array>,
	): void => {
		const l = raw.replace(/\r$/, "");
		if (l.length === 0) {
			dispatch(c); // blank line = event boundary
			return;
		}
		if (l.startsWith(":")) {
			// keep-alive comment: pass through verbatim (never buffered)
			c.enqueue(encoder.encode(`${l}\n`));
			return;
		}
		const colon = l.indexOf(":");
		const field = colon < 0 ? l : l.slice(0, colon);
		let value = colon < 0 ? "" : l.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") eventType = value.trim();
		else if (field === "data") dataLines.push(value);
		// other fields (id/retry): not on the anthropic wire, ignored
	};

	const drain = (c: TransformStreamDefaultController<Uint8Array>): void => {
		let i = buf.indexOf("\n");
		while (i >= 0) {
			line(buf.slice(0, i), c);
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	};

	return new TransformStream({
		transform(chunk, c) {
			buf += decoder.decode(chunk, { stream: true });
			drain(c);
		},
		flush(c) {
			buf += decoder.decode();
			if (buf.length > 0) {
				line(buf, c);
				buf = "";
			}
			dispatch(c); // tail event never closed by a blank line
		},
	});
}
