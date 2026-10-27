import { expect, test } from "./pw";
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
		client: "copilot",
		paths: [],
		diffText: "",
		now: Date.parse(timestamp(10)),
	});

test.describe("native Copilot completion evidence", () => {
	test("pairs timestamped own bash tests and assistant prose", () => {
		const text = transcript(call(), result(), claim);
		const events = transcriptEventsFromText(text, "copilot");
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
		"bun --bun ../../node_modules/.bin/playwright test --config=tests.config.ts",
		"cd packages/belt && bun --bun ../../node_modules/.bin/playwright test --config tests.config.ts",
	])("recognizes direct test command: %s", (command) => {
		expect(
			transcriptEventsFromText(transcript(call(command), result()), "copilot")
				.runs,
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
		"bun --bun ../../node_modules/.bin/playwright test && coord inbox",
		"bun --bun ../../node_modules/.bin/playwright show-report",
	])("does not accept relayed or non-test output: %s", (command) => {
		expect(
			transcriptEventsFromText(transcript(call(command), result()), "copilot")
				.runs,
		).toEqual([]);
		expect(verdict(call(command), result(), claim).ok).toBe(false);
	});

	const nativeRequest = (
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		minute = 1,
	) =>
		event(
			"assistant.message",
			{
				toolRequests: [{ toolCallId, name, arguments: args }],
			},
			minute,
		);
	const nativeResult = (
		toolCallId: string,
		content: string,
		minute = 2,
		success = true,
	) =>
		event(
			"tool.execution_complete",
			{
				toolCallId,
				success,
				result: { content },
			},
			minute,
		);
	const started = nativeResult(
		"own-test",
		"<command with shellId: 42 is still running after 30 seconds. The command is still running but hasn't produced output yet.>",
	);
	const read = (shellId = "42", id = "read", minute = 3) =>
		nativeRequest(id, "read_bash", { shellId, delay: 120 }, minute);
	const finished = (id = "read", shellId = "42", minute = 4) =>
		nativeResult(
			id,
			`2 passed\n<shellId: ${shellId} completed with exit code 0>`,
			minute,
		);

	test.describe("native Copilot asynchronous own tests", () => {
		test("links repeated own reads to a timed-out test shell, not partial counts", () => {
			const waiting = nativeResult(
				"read",
				"<command with shellId: 42 is still running after 120 seconds.>",
				4,
			);
			const frames = [
				call(),
				started,
				read(),
				waiting,
				read("42", "final", 5),
				finished("final", "42", 6),
			];
			const events = transcriptEventsFromText(transcript(...frames), "copilot");
			expect(events.runs).toEqual([
				{
					ts: Date.parse(timestamp(6)),
					text: "2 passed\n<shellId: 42 completed with exit code 0>",
				},
			]);
			expect(
				verdict(
					...frames,
					event("assistant.message", { content: "All tests pass." }, 7),
				).ok,
			).toBe(true);
		});

		test("recognizes direct Bun Playwright in a background test", () => {
			expect(
				transcriptEventsFromText(
					transcript(
						call(
							"bun --bun ../../node_modules/.bin/playwright test --config=tests.config.ts",
						),
						nativeResult(
							"own-test",
							"<command started in background with shellId: 42>",
						),
						read(),
						finished(),
					),
					"copilot",
				).runs,
			).toHaveLength(1);
		});

		test.each(
			[
				[result("2 pass\n0 fail"), read(), finished()],
				[call("coord inbox"), started, read(), finished()],
				[call(), started, read("foreign"), finished()],
				[call(), started, read(), finished("foreign")],
				[call(), started, read(), finished("read", "foreign")],
				[call(), started, finished()],
				[call(), read(), started, finished()],
				[call(), started, read("42", "read", 1), finished()],
				[call(), started, read(), finished("read", "42", 2)],
				[
					call(),
					started,
					read(),
					JSON.stringify({
						type: "tool.execution_complete",
						data: {
							toolCallId: "read",
							success: true,
							result: {
								content: "2 passed\n<shellId: 42 completed with exit code 0>",
							},
						},
					}),
				],
				[
					call(),
					started,
					read(),
					nativeResult(
						"read",
						JSON.stringify({
							tool_results: [
								{
									recipient_name: "functions.bash",
									result: "2 passed\n<shellId: 42 completed with exit code 0>",
								},
							],
						}),
						4,
					),
				],
			].map((frames) => [frames]),
		)(
			"rejects unpaired, foreign, non-test, stale or nested read output %#",
			(frames) => {
				expect(
					transcriptEventsFromText(transcript(...frames), "copilot").runs,
				).toEqual([]);
			},
		);

		test("failed async execution overrides an earlier pass and consumes its shell", () => {
			for (const [content, success] of [
				["2 passed\n<shellId: 42 completed with exit code 1>", true],
				["2 passed\n<shellId: 42 completed with exit code 0>", false],
			] as const) {
				const frames = [
					call(),
					result(),
					call(),
					started,
					read(),
					nativeResult("read", content, 4, success),
					read("42", "again", 5),
					finished("again", "42", 6),
				];
				const runs = transcriptEventsFromText(
					transcript(...frames),
					"copilot",
				).runs;
				expect(runs).toHaveLength(2);
				expect(runs[1]?.text).toStartWith("0 pass\n1 fail");
				expect(
					verdict(
						...frames,
						event("assistant.message", { content: "All tests pass." }, 7),
					).ok,
				).toBe(false);
			}
		});

		test("terminal reads cannot be duplicated or reused after a shell restart/stop", () => {
			for (const invalidate of [
				nativeRequest(
					"reuse",
					"bash",
					{ shellId: "42", command: "coord inbox" },
					4,
				),
				nativeRequest("stop", "stop_bash", { shellId: "42" }, 4),
			]) {
				expect(
					transcriptEventsFromText(
						transcript(call(), started, read(), invalidate, finished()),
						"copilot",
					).runs,
				).toEqual([]);
			}
			expect(
				transcriptEventsFromText(
					transcript(
						call(),
						started,
						read(),
						finished(),
						read("42", "again", 5),
						finished("again", "42", 6),
					),
					"copilot",
				).runs,
			).toHaveLength(1);
			expect(
				transcriptEventsFromText(
					transcript(
						call(),
						started,
						read(),
						nativeRequest("new-test", "bash", { command: "bun test" }, 3),
						nativeResult(
							"new-test",
							"<command started in background with shellId: 42>",
							3,
						),
						finished(),
					),
					"copilot",
				).runs,
			).toEqual([]);
		});

		test("unfinished-call tracking is bounded and fails closed", () => {
			const requests = Array.from({ length: 257 }, (_, i) =>
				nativeRequest(`pending-${i}`, "bash", { command: "bun test" }),
			);
			expect(
				transcriptEventsFromText(
					transcript(
						...requests,
						finished("pending-0"),
						finished("pending-256"),
					),
					"copilot",
				).runs,
			).toEqual([]);
		});

		test("native parallel requests pair independently; wrapper/relayed blobs do not run", () => {
			const requests = event("assistant.message", {
				toolRequests: [
					{
						toolCallId: "own-test",
						name: "bash",
						arguments: { command: "bun test" },
					},
					{
						toolCallId: "noise",
						name: "bash",
						arguments: { command: "coord inbox" },
					},
				],
			});
			expect(
				transcriptEventsFromText(
					transcript(
						requests,
						nativeResult(
							"noise",
							"99 pass\n<shellId: 9 completed with exit code 0>",
						),
						started,
						read(),
						finished(),
					),
					"copilot",
				).runs,
			).toHaveLength(1);
			expect(
				transcriptEventsFromText(
					transcript(
						nativeRequest("wrapper", "multi_tool_use.parallel", {
							tool_uses: [
								{
									recipient_name: "functions.bash",
									parameters: { command: "bun test" },
								},
							],
						}),
						nativeResult(
							"wrapper",
							JSON.stringify({
								results: [
									{
										content: "2 pass\n<shellId: 42 completed with exit code 0>",
									},
								],
							}),
						),
					),
					"copilot",
				).runs,
			).toEqual([]);
		});
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
			expect(
				transcriptEventsFromText(transcript(...frames), "copilot").runs,
			).toEqual([]);
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
			transcriptEventsFromText(
				transcript(JSON.stringify(reversed), result()),
				"copilot",
			).runs,
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
			const runs = transcriptEventsFromText(
				transcript(...frames),
				"copilot",
			).runs;
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
				expect(
					transcriptEventsFromText(transcript(...frames), "copilot").runs,
				).toEqual([]);
			}
		}
		expect(
			transcriptEventsFromText(
				event("assistant.message", { content: "All tests pass." }, 3).replace(
					timestamp(3),
					"invalid",
				),
				"copilot",
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
			"copilot",
		);
		expect(events.claims).toEqual([]);
	});

	test("capsule boundary and claim epoch remain enforced", () => {
		const options = {
			transcriptText: transcript(call(), result(), claim),
			client: "copilot",
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
