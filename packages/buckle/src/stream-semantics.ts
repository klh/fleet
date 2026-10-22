// src/stream-semantics.ts — W1106: body-free semantic outcome classifier.
// A protocol terminal (anthropic message_stop / openai [DONE]) alone is NOT
// proof of a completed turn: the empty-stream incident shipped turns that were
// protocol-perfect yet carried no usable assistant output (exact 483-byte
// envelope — message_start + usage-only terminal + message_stop, out_tok 0).
// This class accumulates three booleans while a stream flows and reduces them
// to ONE typed failure kind at the terminal:
//   empty_response       — no usable text/tool/refusal was ever seen
//   reasoning_only       — only thinking/reasoning deltas arrived
//   output_token_limit   — the turn ended on max_tokens/length with no output
// Usage counters are deliberately NOT evidence of output (out_tok 0 is the
// symptom, not the proof; the 483-byte envelope carried usage 33341/0).
// No text is ever stored — three booleans, whole-stream, body-free.

type AnyRec = Record<string, unknown>;

const rec = (v: unknown): AnyRec =>
	v !== null && typeof v === "object" ? (v as AnyRec) : {};

const text = (v: unknown): boolean => typeof v === "string" && v.length > 0;

export type EmptyStreamKind =
	| "empty_response"
	| "reasoning_only"
	| "output_token_limit";

/** The kinds this classifier owns — in-band error codes it re-marks. */
export const EMPTY_STREAM_KINDS: readonly string[] = [
	"empty_response",
	"reasoning_only",
	"output_token_limit",
];

export const EMPTY_STREAM_MESSAGE =
	"Upstream completed without usable assistant output";

/** The typed error body shared by both bridge directions. */
export const emptyStreamError = (kind: EmptyStreamKind): AnyRec => ({
	type: "api_error",
	code: kind,
	message: EMPTY_STREAM_MESSAGE,
});

export class StreamSemantics {
	private usable = false;
	private reasoning = false;
	private limited = false;

	/** Observe one parsed SSE data frame. Transport-only frames (pings) are
	 *  never handed here — callers filter them before observing. */
	observe(value: unknown, dialect: "anthropic" | "openai"): void {
		const r = rec(value);
		if (dialect === "anthropic") {
			const block = rec(r.content_block);
			const delta = rec(r.delta);
			this.usable ||=
				text(delta.text) ||
				text(block.text) ||
				(block.type === "tool_use" && text(block.name)); // args may stream later; the name is the commitment
			this.reasoning ||=
				text(delta.thinking) ||
				text(block.thinking) ||
				block.type === "redacted_thinking";
			this.limited ||= delta.stop_reason === "max_tokens";
			return;
		}
		const choices = Array.isArray(r.choices) ? r.choices : [];
		for (const c of choices) {
			const choice = rec(c);
			const delta = rec(choice.delta);
			this.usable ||= text(delta.content) || text(delta.refusal);
			this.reasoning ||= text(delta.reasoning_content) || text(delta.reasoning);
			this.limited ||= choice.finish_reason === "length";
			const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
			for (const call of calls) {
				// a named tool call is usable output regardless of argument bytes
				this.usable ||= text(rec(rec(call).function).name);
			}
		}
		// Responses wire (W912): text deltas + function-call items carry output;
		// reasoning summaries do not. A completed/incomplete response carries
		// the WHOLE output in its snapshot — observe it item by item.
		this.usable ||=
			(r.type === "response.output_text.delta" ||
				r.type === "response.audio.delta") &&
			text(r.delta);
		this.observeOutputItem(rec(r.item));
		this.reasoning ||=
			typeof r.type === "string" &&
			r.type.startsWith("response.reasoning") &&
			text(r.delta);
		if (r.type === "response.completed" || r.type === "response.incomplete") {
			const resp = rec(r.response);
			const output = Array.isArray(resp.output) ? resp.output : [];
			for (const o of output) this.observeOutputItem(rec(o));
		}
	}

	/** One Responses-wire output item (from output_item.* events or a
	 *  response.completed snapshot): reasoning items mark reasoning; message
	 *  content entries (output_text/refusal/output_audio) and named function
	 *  calls are usable output — image/audio-bearing payloads must never be
	 *  mislabeled empty. */
	private observeOutputItem(item: AnyRec): void {
		if (item.type === "reasoning" || item.type === "redacted_reasoning") {
			this.reasoning = true;
			return;
		}
		if (item.type === "function_call" && text(item.name)) {
			this.usable = true;
			return;
		}
		if (item.type !== "message") return;
		const content = Array.isArray(item.content) ? item.content : [];
		for (const c of content) {
			const part = rec(c);
			this.usable ||=
				(part.type === "output_text" && text(part.text)) ||
				(part.type === "refusal" && text(part.refusal)) ||
				part.type === "output_audio";
		}
	}

	/** The typed failure at the terminal, or null when the turn carried
	 *  usable output (or a REAL in-band failure owns the stream instead). */
	failure(): EmptyStreamKind | null {
		if (this.usable) return null;
		return this.limited
			? "output_token_limit"
			: this.reasoning
				? "reasoning_only"
				: "empty_response";
	}
}
