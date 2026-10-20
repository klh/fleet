#!/usr/bin/env bun
import { createInterface } from "node:readline";

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		clearTimeout(timer);
		emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
		emit({ type: "result", subtype: "error_during_execution", is_error: true });
	} else if (frame.type === "user" && !started) {
		started = true;
		emit({ type: "system", subtype: "init", session_id: "same-native-session", pid: process.pid });
		timer = setTimeout(() => emit({ type: "result", subtype: "success", result: "ORIGINAL_COMPLETE" }), 3000);
	} else if (frame.type === "user") {
		emit({ type: "assistant", message: { content: [{ type: "text", text: "FIXTURE_INTERRUPT_ACK" }] } });
		emit({ type: "result", subtype: "success", result: "FIXTURE_INTERRUPT_ACK", session_id: "same-native-session", pid: process.pid });
	}
});
