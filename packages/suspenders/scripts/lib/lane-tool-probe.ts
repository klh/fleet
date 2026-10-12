type Block = Record<string, unknown>;
type Reply = { content?: Block[]; stop_reason?: string };
type Request = (body: Record<string, unknown>) => Promise<Reply>;

/** Prove both directions of the tool protocol, not merely inference availability. */
export async function laneToolRoundtrip(
	request: Request,
	nonce = crypto.randomUUID(),
): Promise<{ ok: boolean; detail: string }> {
	const tool = "fleet_health_read";
	const messages: Record<string, unknown>[] = [
		{
			role: "user",
			content:
				"Call fleet_health_read with path health.txt. Then return exactly its result, without commentary.",
		},
	];
	const tools = [
		{
			name: tool,
			description: "Read the health test result.",
			input_schema: {
				type: "object",
				properties: { path: { type: "string", enum: ["health.txt"] } },
				required: ["path"],
				additionalProperties: false,
			},
		},
	];
	const base = { model: "glm-5.3-flash", max_tokens: 256, tools };
	const first = await request({
		...base,
		messages,
		tool_choice: { type: "tool", name: tool },
	});
	const calls = first.content?.filter((b) => b.type === "tool_use") ?? [];
	const call = calls[0];
	if (
		first.stop_reason !== "tool_use" ||
		calls.length !== 1 ||
		!call ||
		call.name !== tool ||
		typeof call.id !== "string" ||
		!call.id ||
		typeof call.input !== "object" ||
		call.input === null ||
		Array.isArray(call.input) ||
		(call.input as Record<string, unknown>).path !== "health.txt"
	) {
		return { ok: false, detail: "missing or invalid structured tool_use" };
	}
	// Preserve every assistant block (including provider thinking signatures).
	messages.push({ role: "assistant", content: first.content });
	messages.push({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: call.id, content: nonce }],
	});
	const second = await request({
		...base,
		messages,
		tool_choice: { type: "none" },
	});
	const answer = second.content
		?.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
	return second.stop_reason === "end_turn" && answer === nonce
		? { ok: true, detail: "structured tool_use/result/followup verified" }
		: { ok: false, detail: "tool_result followup did not return nonce" };
}
