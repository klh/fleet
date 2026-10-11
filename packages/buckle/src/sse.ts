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
import { type Usage, usageFromAnthropic, usageFromOpenAI } from "./usage.ts";

type AnyRec = Record<string, unknown>;

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

	constructor(private readonly dialect: Dialect) {}

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
		try {
			if (payload.length > 0 && payload !== "[DONE]")
				this.data(JSON.parse(payload));
		} catch {
			// non-JSON data: not usage-bearing, ignore honestly
		}
		this.eventType = "";
	}

	private data(json: unknown): void {
		if (!json || typeof json !== "object") return;
		const r = json as AnyRec;
		if (this.dialect === "anthropic") {
			const t = typeof r.type === "string" ? r.type : this.eventType;
			if (t === "message_start") {
				const msg = (r.message ?? {}) as AnyRec;
				const u = usageFromAnthropic(msg.usage);
				if (u !== null) this.start = u;
			} else if (t === "message_delta") {
				const u = usageFromAnthropic(r.usage);
				if (u !== null && u.out_tok > this.deltaOut) this.deltaOut = u.out_tok;
				// cumulative input side may ride message_delta (the cross-dialect
				// bridge always puts it there; newer anthropic wires do too)
				if (u !== null && u.in_tok > (this.start?.in_tok ?? 0))
					this.start = {
						in_tok: u.in_tok,
						out_tok: this.start?.out_tok ?? 0,
						cache_r: this.start?.cache_r ?? 0,
						cache_c: this.start?.cache_c ?? 0,
					};
			}
			return;
		}
		const u = usageFromOpenAI(r.usage);
		if (u !== null) this.openai = u; // last chunk wins
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
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
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

	const dispatch = (c: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = dataLines.join("\n").trim();
		const evt = eventType;
		dataLines = [];
		eventType = "";
		if (evt === "ping") {
			drop("ping", payload.slice(0, 80));
			return;
		}
		if (payload.length === 0) {
			if (evt.length > 0) c.enqueue(encoder.encode(`event: ${evt}\n\n`));
			return;
		}
		if (payload !== "[DONE]") {
			try {
				const j: unknown = JSON.parse(payload);
				if (j && typeof j === "object" && (j as AnyRec).type === "ping") {
					drop("ping", payload.slice(0, 80));
					return;
				}
			} catch {
				drop("corrupt", payload.slice(0, 80));
				return;
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
