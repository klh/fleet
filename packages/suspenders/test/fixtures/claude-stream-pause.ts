#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const sid = process.env.SUSPENDERS_SID ?? "";
const coord = new URL("../../hooks/bin/coord.ts", import.meta.url).pathname;
const call = (args: string[]) => execFileSync(process.execPath, [coord, ...args, "--as", sid], { encoding: "utf8" });
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		clearTimeout(timer);
		emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
		emit({ type: "result", subtype: "error_during_execution", is_error: true });
		return;
	}
	if (frame.type !== "user") return;
	const text = frame.message.content as string;
	if (!started) {
		started = true;
		emit({ type: "system", subtype: "init", session_id: "pause-native-session", pid: process.pid });
		timer = setTimeout(() => emit({ type: "result", result: "ORIGINAL_COMPLETE" }), 5000);
	} else if (text.includes("FLEET_MANAGED_PAUSE:")) {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		call(["capsule", "set", `--checkpoint=${sha}`, "--done=fixture checkpoint", "--next=fixture continuation"]);
		call(["paused", "--sha", sha]);
		emit({ type: "result", subtype: "success", result: "CHECKPOINTED", pid: process.pid });
	} else if (text.includes("FLEET_MANAGED_RESUME:")) {
		call(["resumed"]);
		emit({ type: "result", subtype: "success", result: "RESUMED", pid: process.pid, session_id: "pause-native-session" });
	} else {
		emit({ type: "result", result: "UNEXPECTED_NORMAL_WORK" });
	}
});
