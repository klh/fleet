type Block = Record<string, unknown>;
type Reply = { content: Block[]; stop_reason?: string };

/** Decode the bounded Anthropic stream used by the watchdog's two-turn probe. */
export async function laneProbeReply(response: Response): Promise<Reply> {
	if (!response.body) throw new Error("lane front returned no SSE body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const content: Block[] = [];
	const toolInputs = new Map<number, string>();
	let stopReason: string | undefined;
	let stopped = false;
	let buffer = "";
	let data: string[] = [];
	let bytes = 0;
	const dispatch = () => {
		if (data.length === 0) return;
		const event = JSON.parse(data.join("\n")) as Record<string, unknown>;
		data = [];
		if (event.type === "error")
			throw new Error(`lane front SSE error: ${JSON.stringify(event.error)}`);
		if (event.type === "message_stop") stopped = true;
		if (event.type === "message_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			if (typeof delta?.stop_reason === "string")
				stopReason = delta.stop_reason;
		}
		const index = event.index;
		if (typeof index !== "number" || index < 0 || index > 16) return;
		if (event.type === "content_block_start") {
			content[index] = (event.content_block as Block | undefined) ?? {};
		}
		if (event.type === "content_block_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			const block = content[index];
			if (!delta || !block) return;
			if (delta.type === "text_delta" && typeof delta.text === "string")
				block.text = String(block.text ?? "") + delta.text;
			if (delta.type === "thinking_delta" && typeof delta.thinking === "string")
				block.thinking = String(block.thinking ?? "") + delta.thinking;
			if (
				delta.type === "signature_delta" &&
				typeof delta.signature === "string"
			)
				block.signature = String(block.signature ?? "") + delta.signature;
			if (
				delta.type === "input_json_delta" &&
				typeof delta.partial_json === "string"
			)
				toolInputs.set(
					index,
					(toolInputs.get(index) ?? "") + delta.partial_json,
				);
		}
		if (event.type === "content_block_stop" && toolInputs.has(index)) {
			content[index].input = JSON.parse(toolInputs.get(index) ?? "{}");
			toolInputs.delete(index);
		}
	};
	const lines = () => {
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end).replace(/\r$/, "");
			buffer = buffer.slice(end + 1);
			if (line === "") dispatch();
			else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			end = buffer.indexOf("\n");
		}
	};
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 262_144)
				throw new Error("lane front SSE exceeded probe bound");
			buffer += decoder.decode(chunk.value, { stream: true });
			lines();
		}
		buffer += decoder.decode();
		lines();
		if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
		dispatch();
	} finally {
		reader.releaseLock();
	}
	if (!stopped) throw new Error("lane front SSE ended before message_stop");
	return { content: content.filter(Boolean), stop_reason: stopReason };
}
