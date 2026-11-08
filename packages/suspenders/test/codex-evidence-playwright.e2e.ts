import { expect, test } from "@playwright/test";
import {
	transcriptEventsFromText,
	claimCheckVerdict,
} from "../hooks/lib/gates/claim-check.ts";

const entry = (payload: object, second: number) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(1700000000000 + second * 1000).toISOString(),
		payload,
	});
const call = (id: string, input: string, second: number) =>
	entry({ type: "custom_tool_call", name: "exec", call_id: id, input }, second);
const output = (id: string, result: object, second: number) =>
	entry(
		{
			type: "custom_tool_call_output",
			call_id: id,
			output: [
				{
					type: "text",
					text: `Script completed\nOutput:\n${JSON.stringify(result)}`,
				},
			],
		},
		second,
	);
const start = (command: string) =>
	`text(await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/fixture"}));`;
const poll = (id: number, chars = "") =>
	`text(await tools.write_stdin({session_id:${id},chars:${JSON.stringify(chars)}}));`;

test("Codex joins split summaries only after the owned process exits @unit", () => {
	const text = [
		call("s", start("bun test"), 1),
		output("s", { output: "7 pa", session_id: 42 }, 2),
		call("p", poll(42), 3),
		output("p", { output: "ss\n0 fail", exit_code: 0 }, 4),
	].join("\n");
	expect(transcriptEventsFromText(text, "codex").runs).toHaveLength(1);
});

test("Codex session reuse and stdin mutation permanently invalidate prior lineage @unit", () => {
	for (const mutation of [start("echo other"), poll(42, "inject"), poll(42)]) {
		const result =
			mutation === poll(42)
				? { output: "", session_id: 99 }
				: { output: "", session_id: 42 };
		const text = [
			call("s", start("bun test"), 1),
			output("s", { output: "7 pass\n0 fail", session_id: 42 }, 2),
			call("m", mutation, 3),
			output("m", result, 4),
			call("p", poll(42), 5),
			output("p", { output: "", exit_code: 0 }, 6),
		].join("\n");
		expect(transcriptEventsFromText(text, "codex").runs, mutation).toHaveLength(
			0,
		);
	}
});

test("Codex owns direct Playwright evidence from an exited native tool result @unit", () => {
	const text = [
		call(
			"start",
			start("bun --bun x playwright test --config test/playwright.config.ts"),
			1,
		),
		output("start", { output: "15 passed (1.4s)", exit_code: 0 }, 2),
	].join("\n");
	expect(transcriptEventsFromText(text, "codex").runs).toHaveLength(1);
});

test("Codex correlates test PTY completion and never banks partial summaries @unit", () => {
	const before = [
		call("start", start("bun test fixture.test.ts"), 1),
		output("start", { output: "7 pass\n0 fail\n", session_id: 42 }, 2),
	].join("\n");
	expect(transcriptEventsFromText(before, "codex").runs).toHaveLength(0);
	const text = [
		before,
		call("wait", poll(42), 3),
		output("wait", { output: "Ran 7 tests", exit_code: 0 }, 4),
	].join("\n");
	expect(transcriptEventsFromText(text, "codex").runs).toHaveLength(1);
});

test("Codex rejects foreign PTYs, stdin writes, computed commands and appended fake reports @unit", () => {
	for (const input of [
		poll(99),
		poll(42, "echo fake"),
		"text(await tools.exec_command({cmd:command}));",
		`${start("bun test fixture.test.ts")}text("999 pass 0 fail");`,
		start("bun test; echo fake"),
	]) {
		const text = [
			call("start", start("bun test fixture.test.ts"), 1),
			output("start", { output: "", session_id: 42 }, 2),
			call("foreign", input, 3),
			output("foreign", { output: "999 pass\n0 fail", exit_code: 0 }, 4),
		].join("\n");
		expect(transcriptEventsFromText(text, "codex").runs, input).toHaveLength(0);
	}
});

test("Codex nonzero process exit contradicts a passing summary @unit", () => {
	const text = [
		entry(
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "All tests pass" }],
			},
			1,
		),
		call("start", start("bun test fixture.test.ts"), 2),
		output("start", { output: "7 pass\n0 fail", exit_code: 1 }, 3),
	].join("\n");
	expect(
		claimCheckVerdict({
			transcriptText: text,
			client: "codex",
			paths: [],
			diffText: "",
			now: 1700000010000,
		}).ok,
	).toBe(false);
});

test("native JSON-quoted argument keys retain own synchronous and async evidence @unit", () => {
	const source =
		"text(await tools.exec_command(" +
		JSON.stringify({
			cmd: "bun test fixture.test.ts",
			workdir: "/fixture",
			yield_time_ms: 10000,
			max_output_tokens: 1200,
		}) +
		"));";
	const direct = [
		call("s", source, 1),
		output("s", { output: "7 pass\n0 fail", exit_code: 0 }, 2),
	].join("\n");
	expect(transcriptEventsFromText(direct, "codex").runs).toHaveLength(1);
	const wait =
		"text(await tools.write_stdin(" +
		JSON.stringify({ session_id: 42, chars: "", yield_time_ms: 1000 }) +
		"));";
	const asyncText = [
		call("s", source, 1),
		output("s", { output: "7 pass\n0 fail", session_id: 42 }, 2),
		call("w", wait, 3),
		output("w", { output: "", exit_code: 0 }, 4),
	].join("\n");
	expect(transcriptEventsFromText(asyncText, "codex").runs).toHaveLength(1);
});
