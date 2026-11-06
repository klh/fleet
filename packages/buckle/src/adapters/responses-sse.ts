// src/adapters/responses-sse.ts — W2583: Responses SSE bytes → openai chat
// chunk SSE bytes. Text deltas become content chunks; the terminal event
// closes with a finish chunk + an include_usage chunk + [DONE] (openai
// include_usage semantics); keepalive comments pass through. Non-text
// output items (tool calls, reasoning) are ignored — text-only translation
// at this tier; the [DONE] protocol terminal rides the terminal event.
type AnyRec = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

const chunkFrame = (
	id: string,
	model: string,
	delta: AnyRec,
	finish: string | null = null,
): string =>
	`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

const usageFrame = (id: string, model: string, usage: AnyRec): string =>
	`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		model,
		choices: [],
		usage: {
			prompt_tokens: num(usage.input_tokens),
			completion_tokens: num(usage.output_tokens),
			total_tokens: num(usage.total_tokens),
		},
	})}\n\n`;

/** Responses SSE → chat chunk SSE. One decoder, one line parser. */
export function responsesToChatSse(): TransformStream<Uint8Array, Uint8Array> {
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	let buf = "";
	let data: string[] = [];
	let chunkId = "resp-bridge";
	let model = "";
	let done = false;
	const dispatch = (c: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = data.join("\n").trim();
		data = [];
		if (payload.length === 0) return;
		let r: AnyRec;
		try {
			r = JSON.parse(payload) as AnyRec;
		} catch {
			return;
		}
		switch (r.type) {
			case "response.created": {
				const resp = (r.response ?? {}) as AnyRec;
				chunkId = latched(resp, chunkId, "id");
				model = latched(resp, model, "model");
				c.enqueue(
					enc.encode(
						chunkFrame(chunkId, model, { role: "assistant", content: "" }),
					),
				);
				break;
			}
			case "response.output_text.delta": {
				const text = str(r.delta);
				if (text.length > 0)
					c.enqueue(enc.encode(chunkFrame(chunkId, model, { content: text })));
				break;
			}
			case "response.completed":
			case "response.incomplete": {
				if (done) break;
				done = true;
				terminal(c, r);
				break;
			}
			default:
				break;
		}
	};
	const terminal = (
		c: TransformStreamDefaultController<Uint8Array>,
		r: AnyRec,
	): void => {
		const resp = (r.response ?? {}) as AnyRec;
		const usage = (resp.usage ?? {}) as AnyRec;
		const id = str(resp.id) || chunkId;
		const mdl = model || str(resp.model);
		const finish = r.type === "response.incomplete" ? "length" : "stop";
		c.enqueue(enc.encode(chunkFrame(id, mdl, {}, finish)));
		c.enqueue(enc.encode(usageFrame(id, mdl, usage)));
		c.enqueue(enc.encode("data: [DONE]\n\n"));
	};
	const line = (
		l: string,
		c: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (l.length === 0) dispatch(c);
		else if (l.startsWith("data:"))
			data.push(l.startsWith("data: ") ? l.slice(6) : l.slice(5));
		else if (l.startsWith(":")) c.enqueue(enc.encode(`${l}\n`));
	};
	const drain = (c: TransformStreamDefaultController<Uint8Array>): void => {
		let i = buf.indexOf("\n");
		while (i >= 0) {
			line(buf.slice(0, i).replace(/\r$/, ""), c);
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	};
	return new TransformStream({
		transform(chunk, c) {
			buf += dec.decode(chunk, { stream: true });
			drain(c);
		},
		flush(c) {
			buf += `${dec.decode()}\n`;
			drain(c);
		},
	});
}

/** resp's string field if present, else the latched value. */
const latched = (resp: AnyRec, current: string, key: string): string =>
	str(resp[key]) || current;
