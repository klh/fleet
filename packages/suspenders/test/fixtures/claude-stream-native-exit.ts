#!/usr/bin/env bun
// W1035.1 fixture: a native Claude that dies right after accepting an
// interrupt during an in-flight tool_use — no interrupted turn's result
// frame, no injection ack. The managed runtime must exit cleanly and leave
// the direct event replayable (claim released, watermark untouched).
import { createInterface } from "node:readline";

const emit = (value: unknown) =>
	process.stdout.write(`${JSON.stringify(value)}\n`);
let started = false;
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		emit({
			type: "control_response",
			response: { subtype: "success", request_id: frame.request_id },
		});
		setTimeout(() => process.exit(0), 10); // native death mid-interrupt
	} else if (frame.type === "user" && !started) {
		started = true;
		emit({
			type: "system",
			subtype: "init",
			session_id: "exit-native-session",
			pid: process.pid,
		});
		// the interrupted turn is inside a tool_use when the interrupt lands
		emit({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 30" } },
				],
			},
		});
	}
});
