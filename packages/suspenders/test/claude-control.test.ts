import { expect, test } from "bun:test";
import {
	ClaudeControl,
	claudeStreamArguments,
} from "../hooks/lib/executors/claude-control.ts";

test("managed argv preserves settings and resume flags while owning the stream", () => {
	const parsed = claudeStreamArguments([
		"-p",
		"original",
		"--settings",
		"private.json",
		"--resume",
		"session",
	]);
	expect(parsed.prompt).toBe("original");
	expect(parsed.args).toEqual([
		"--settings",
		"private.json",
		"--resume",
		"session",
		"-p",
		"--verbose",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
	]);
});

test("active work is interrupted before the new direct message enters the same session", async () => {
	const sent: Record<string, unknown>[] = [];
	const control = new ClaudeControl((frame) => sent.push(frame));
	control.start("original");
	const steer = control.steer("direct");
	const request = sent.at(-1);
	expect(request?.type).toBe("control_request");
	expect(request?.request).toEqual({ subtype: "interrupt" });
	control.receive({
		type: "control_response",
		response: { subtype: "success", request_id: request?.request_id },
	});
	await Promise.resolve();
	expect(sent.filter((frame) => frame.type === "user")).toHaveLength(1);
	control.receive({
		type: "result",
		subtype: "error_during_execution",
		is_error: true,
	});
	await steer;
	expect(sent.at(-1)).toMatchObject({
		type: "user",
		message: { role: "user", content: "direct" },
	});
	expect(control.active).toBe(true);
	control.close();
});

test("a failed interrupt never injects a message or claims successful cancellation", async () => {
	const sent: Record<string, unknown>[] = [];
	const control = new ClaudeControl((frame) => sent.push(frame));
	control.start("original");
	const steer = control.steer("direct");
	control.receive({
		type: "control_response",
		response: {
			subtype: "error",
			request_id: sent.at(-1)?.request_id,
			error: "unsupported",
		},
	});
	await expect(steer).rejects.toThrow("unsupported");
	expect(sent.filter((frame) => frame.type === "user")).toHaveLength(1);
	control.close();
});
