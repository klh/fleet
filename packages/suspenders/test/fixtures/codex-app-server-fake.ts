#!/usr/bin/env bun
// W1052.2.2 fixture: a fake native codex binary. With "app-server" it hosts
// the managed face on stdio (thread id fixed, turn completes on start);
// FAKE_FAIL=1 answers initialize with an error so the caller's fallback
// path runs. With "exec" it proves the verbatim fallback argv arrived.
import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "exec") {
	process.stdout.write("exec-fallback-ran\n");
	process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line) as {
		id?: number;
		method: string;
		params?: Record<string, unknown>;
	};
	if (request.method === "initialized") continue;
	if (request.method === "initialize" && process.env.FAKE_FAIL === "1") {
		process.stdout.write(
			`${JSON.stringify({ id: request.id, error: { message: "fixture refuses managed mode" } })}\n`,
		);
		continue;
	}
	let result: unknown;
	if (request.method === "initialize") result = { userAgent: "fixture" };
	else if (request.method === "thread/start")
		result = { thread: { id: "019b0ba5-4c7e-7d51-99fa-85704ad78b99" } };
	else if (request.method === "thread/read")
		result = {
			thread: {
				status: { type: "active", activeFlags: [] },
				turns: [{ id: "turn-1", status: "inProgress" }],
			},
		};
	else if (request.method === "turn/steer") {
		if (request.params?.expectedTurnId !== "turn-1")
			throw new Error("wrong active turn");
		result = { turnId: "turn-1" };
	} else if (request.method === "turn/start") {
		// Real app-server answers turn/start when the turn settles; the
		// completed notification precedes the response on the same wire.
		const settle = (): void => {
			process.stdout.write(
				`${JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })}\n`,
			);
			process.stdout.write(
				`${JSON.stringify({ id: request.id, result: { turnId: "turn-1" } })}\n`,
			);
		};
		if (process.env.FAKE_HOLD_MS) {
			setTimeout(settle, Number(process.env.FAKE_HOLD_MS));
			continue;
		}
		settle();
		continue;
	} else {
		process.stdout.write(
			`${JSON.stringify({ id: request.id, error: { message: `unexpected method ${request.method}` } })}\n`,
		);
		continue;
	}
	process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
