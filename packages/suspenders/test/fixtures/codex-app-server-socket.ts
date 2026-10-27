#!/usr/bin/env bun
// W1052.2.2 fixture: a managed lane's per-lane steer socket — the same
// JSON-RPC face the proxy fixture answers, served over a unix socket at
// argv[2]. Stays alive until the test kills it.
const path = process.argv[2];
if (!path) throw new Error("usage: codex-app-server-socket.ts <socket-path>");
Bun.listen({
	unix: path,
	socket: {
		open: (socket) => {
			socket.data = { buffer: "" }; // Bun never seeds socket.data
		},
		data: (socket, chunk) => {
			const state = socket.data as { buffer: string };
			state.buffer += chunk;
			for (;;) {
				const nl = state.buffer.indexOf("\n");
				if (nl < 0) break;
				const line = state.buffer.slice(0, nl);
				state.buffer = state.buffer.slice(nl + 1);
				let request: { id?: number; method: string; params?: Record<string, unknown> };
				try {
					request = JSON.parse(line);
				} catch {
					continue;
				}
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
					if (request.params?.expectedTurnId !== "turn-live") {
						socket.write(
							`${JSON.stringify({ id: request.id, error: { message: "wrong active turn" } })}\n`,
						);
						continue;
					}
					result = { turnId: "turn-live" };
				} else {
					socket.write(
						`${JSON.stringify({ id: request.id, error: { message: `unexpected method ${request.method}` } })}\n`,
					);
					continue;
				}
				socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
			}
		},
	},
});
setInterval(() => {}, 10_000);
