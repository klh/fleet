// Faithful JSON-RPC fixture for the Codex app-server proxy's three requests.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line) as {
		id?: number;
		method: string;
		params?: Record<string, unknown>;
	};
	if (request.method === "initialized") continue;
	let result: unknown;
	if (request.method === "initialize") result = { userAgent: "fixture" };
	else if (request.method === "thread/read")
		result = {
			thread: {
				status: { type: "active", activeFlags: [] },
				turns: [{ id: "turn-live", status: "inProgress" }],
			},
		};
	else if (request.method === "turn/steer") {
		if (request.params?.expectedTurnId !== "turn-live")
			throw new Error("wrong active turn");
		result = { turnId: "turn-live" };
	} else throw new Error(`unexpected method ${request.method}`);
	process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
