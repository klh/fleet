import { describe, expect, test } from "bun:test";
import {
	claimCheckVerdict,
	transcriptEventsFromText,
} from "../hooks/lib/gates/claim-check.ts";

const timestamp = (minute: number) =>
	new Date(Date.UTC(2026, 9, 26, 10, minute)).toISOString();
const event = (
	type: string,
	data: Record<string, unknown>,
	minute = 1,
): string => JSON.stringify({ type, timestamp: timestamp(minute), data });
const call = (command = "bun test product.test.ts", name = "bash") =>
	event("assistant.message", {
		content: "",
		toolRequests: [{ toolCallId: "own-test", name, arguments: { command } }],
	});
const result = (
	content = "1 pass\n0 fail\n<shellId: 1 completed with exit code 0>",
	success: unknown = true,
	toolCallId = "own-test",
) =>
	event(
		"tool.execution_complete",
		{ toolCallId, success, result: { content } },
		2,
	);
const claim = event("assistant.message", { content: "All tests pass." }, 3);
const transcript = (...frames: string[]) => frames.join("\n");
const verdict = (...frames: string[]) =>
	claimCheckVerdict({
		transcriptText: transcript(...frames),
		paths: [],
		diffText: "",
		now: Date.parse(timestamp(4)),
	});

describe("native Copilot completion evidence", () => {
	test("pairs timestamped own bash tests and assistant prose", () => {
		const text = transcript(call(), result(), claim);
		const events = transcriptEventsFromText(text);
		expect(events.runs).toHaveLength(1);
		expect(events.runs[0]?.ts).toBe(Date.parse(timestamp(2)));
		expect(events.claims).toEqual([
			{ ts: Date.parse(timestamp(3)), text: "All tests pass." },
		]);
		expect(verdict(call(), result(), claim).ok).toBe(true);
	});

	test.each([
		"bun test product.test.ts",
		"cd .worktrees/W1357 && bun test product.test.ts",
		'cd "a directory" && npm run test -- --runInBand',
		"pnpm test",
		"yarn test",
		"vitest run",
		"jest product.test.ts",
		"node --test product.test.ts",
		"cargo test",
		"go test ./...",
		"pytest",
	])("recognizes direct test command: %s", (command) => {
		expect(
			transcriptEventsFromText(transcript(call(command), result())).runs,
		).toHaveLength(1);
		expect(verdict(call(command), result(), claim).ok).toBe(true);
	});

	test.each([
		"coord inbox --as owner",
		'echo "bun test"',
		"printf 'bun test'",
		"rg 'bun test' README.md",
		'cd . && echo "bun test"',
		"bun test; coord inbox",
		"bun test || coord inbox",
		"bun test | tail",
		"bun test $(coord inbox)",
		"bun test `coord inbox`",
		"bun test\ncoord inbox",
	])("does not accept relayed or non-test output: %s", (command) => {
		expect(
			transcriptEventsFromText(transcript(call(command), result())).runs,
		).toEqual([]);
		expect(verdict(call(command), result(), claim).ok).toBe(false);
	});

	test("task, notification, user and unmatched results cannot supply runs", () => {
		for (const frames of [
			[call("bun test", "task"), result()],
			[call("bun test", "read_agent"), result()],
			[call(), result(undefined, true, "foreign-test")],
			[result()],
			[
				event("user.message", {
					toolRequests: [
						{
							toolCallId: "own-test",
							name: "bash",
							arguments: { command: "bun test" },
						},
					],
				}),
				result(),
			],
			[event("notification", { content: "1 pass\n0 fail" })],
		]) {
			expect(transcriptEventsFromText(transcript(...frames)).runs).toEqual([]);
			expect(verdict(...frames, claim).ok).toBe(false);
		}
	});

	test.each([
		["0 pass\n1 fail\n<shellId: 1 completed with exit code 1>", true],
		["1 pass\n0 fail\n<shellId: 1 completed with exit code 1>", true],
		["1 pass\n0 fail\n<shellId: 1 completed with exit code 0>", false],
		["1 pass\n0 fail\n<shellId: 1 completed with exit code 0>", null],
	])("unsuccessful results never back a claim", (content, success) => {
		expect(verdict(call(), result(content, success), claim).ok).toBe(false);
	});

	test("a later unsuccessful invocation invalidates an earlier passing run", () => {
		expect(
			verdict(call(), result(), call(), result(undefined, false), claim).ok,
		).toBe(false);
	});

	test("missing success and reversed timestamps cannot back a claim", () => {
		const missingSuccess = JSON.parse(result());
		delete missingSuccess.data.success;
		expect(verdict(call(), JSON.stringify(missingSuccess), claim).ok).toBe(
			false,
		);
		const reversed = JSON.parse(call());
		reversed.timestamp = timestamp(3);
		expect(
			transcriptEventsFromText(transcript(JSON.stringify(reversed), result()))
				.runs,
		).toEqual([]);
	});

	test("partial, unpaired and consumed results cannot be reused", () => {
		for (const frames of [
			[
				call(),
				result(
					"1 pass\n0 fail\n<command started in background with shellId: 1>",
				),
			],
			[result(), call()],
			[
				call(),
				result(),
				result("0 pass\n1 fail\n<shellId: 1 completed with exit code 1>"),
			],
		]) {
			const runs = transcriptEventsFromText(transcript(...frames)).runs;
			expect(runs).toHaveLength(frames.length === 3 ? 1 : 0);
		}
	});

	test("both sides of the pair and prose require valid timestamps", () => {
		for (const frame of [call(), result()]) {
			for (const stamp of [undefined, "not-a-timestamp"]) {
				const parsed = JSON.parse(frame);
				parsed.timestamp = stamp;
				const frames =
					frame === call()
						? [JSON.stringify(parsed), result()]
						: [call(), JSON.stringify(parsed)];
				expect(transcriptEventsFromText(transcript(...frames)).runs).toEqual(
					[],
				);
			}
		}
		expect(
			transcriptEventsFromText(
				event("assistant.message", { content: "All tests pass." }, 3).replace(
					timestamp(3),
					"invalid",
				),
			).claims,
		).toEqual([]);
	});

	test("user/relayed prose and negated assistant text never claim", () => {
		const events = transcriptEventsFromText(
			transcript(
				event("user.message", { content: "All tests pass." }),
				event("tool.execution_complete", {
					result: { content: "All tests pass." },
				}),
				event("assistant.message", { content: "Tests are not passing." }),
			),
		);
		expect(events.claims).toEqual([]);
	});

	test("capsule boundary and claim epoch remain enforced", () => {
		const options = {
			transcriptText: transcript(call(), result(), claim),
			paths: [],
			diffText: "",
			capsuleDone: "All tests pass.",
		};
		expect(
			claimCheckVerdict({ ...options, capsuleTs: Date.parse(timestamp(1)) }).ok,
		).toBe(false);
		expect(
			claimCheckVerdict({
				...options,
				capsuleTs: Date.parse(timestamp(4)),
				claimStartedAt: Date.parse(timestamp(3)),
			}).ok,
		).toBe(false);
	});
});
