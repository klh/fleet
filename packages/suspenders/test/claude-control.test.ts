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

test("awaitResult resolves true on the injected turn's result, false on close", async () => {
	const control = new ClaudeControl(() => {});
	control.start("original");
	const proof = control.awaitResult(1000);
	control.receive({ type: "result", subtype: "success", result: "done" });
	expect(await proof).toBe(true);
	const proof2 = control.awaitResult(1000);
	control.close(); // native exit mid-injection: NOT delivered — replay
	expect(await proof2).toBe(false);
});

test("routine notes wait for the turn boundary instead of interrupting", async () => {
	const sent: Record<string, unknown>[] = [];
	const control = new ClaudeControl((frame) => sent.push(frame));
	control.start("original");
	const boundary = control.boundary();
	await Promise.resolve();
	// nothing was sent while waiting — no interrupt frame for a routine note
	expect(sent).toHaveLength(1);
	control.receive({ type: "result", subtype: "success", result: "turn end" });
	await boundary;
	control.start("routine");
	expect(
		sent.filter(
			(frame) =>
				frame.type === "control_request" &&
				frame.request?.subtype === "interrupt",
		),
	).toHaveLength(0);
	expect(sent.filter((frame) => frame.type === "user")).toHaveLength(2);
	control.close();
});
