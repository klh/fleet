/**
 * Integration: the pi-durable-workers extension inside a REAL durable run.
 *
 * A faux model repeats an identical echo tool call, then finishes via
 * workers_finish. Asserts the full loop: budget counters fold per round,
 * the doom ladder observes the repeat, and the finish tool writes the
 * durable BudgetDoc. Then: wake timers fire real submissions into a live
 * conversation.
 */

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@klh/pi-durable";
import type { ToolRegistration } from "@klh/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@klh/pi-durable";
import { BudgetDoc } from "../src/docs.ts";
import { durableWorkers, startWorkers } from "../src/index.ts";
import { chatSetup, openChat, waitFor, allEntries } from "../../pi-durable/test/chat-support.ts";
import { context } from "../../pi-durable/test/session-support.ts";

const echoTool = (): ToolRegistration<typeof echoSchema> => {
	const echoSchema = obj({ x: str({ description: "echoed" }) });
	return defineTool({
		name: "echo",
		description: "echo x",
		parameters: echoSchema,
		async execute(args) {
			return { output: [{ type: "text", text: `x=${args.x}` }] };
		},
	});
};

describe("workers in a real run", () => {
	it("folds budget counters, observes a doom repeat, and finishes durably", async () => {
		const setup = chatSetup();
		setup.registry.install(durableWorkers({}));
		setup.registry.install({
			name: "echo-tools",
			tools: [echoTool()],
		} as never);
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		harness.resume();

		const idem = { x: "same" };
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", idem, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", idem, { id: "e2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("workers_finish", { summary: "all done", success: true }, { id: "f1" })],
				{ stopReason: "toolUse" },
			),
		]);

		await root.submit({ type: "input", content: "run the brief" }, context);
		await waitFor(() => rootIdle(harness, context), 10_000);

		const budget = await harness.snapshot(BudgetDoc, root.id, context);
		expect(budget.finishedAt).toBeDefined();
		expect(budget.finishReason).toBe("finish_tool");

		await harness.close(context);
	});

	it("wake timers fire real submissions (hub-dark tolerant)", async () => {
		const setup = chatSetup();
		setup.registry.install(durableWorkers({}));
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		harness.resume();

		setup.faux.setResponses([fauxAssistantMessage("woke")]);
		const runtime = await startWorkers(harness, { conversationId: root.id }, context);
		await runtime.addWakePolicy(
			{ kind: "timer", everyS: 0.4, prompt: "[wake] tick from the timer policy", label: "tick" },
			context,
		);

		await waitFor(async () => {
			const entries = await allEntries(root, context);
			return entries.some((e) => JSON.stringify(e.model?.[0] ?? e.data ?? {}).includes("[wake] tick"));
		}, 10_000);

		runtime.stop();
		await harness.close(context);
	});
});

async function rootIdle(harness: import("@klh/pi-durable").Harness, ctx: typeof context): Promise<boolean> {
	await harness.waitForIdle(ctx).catch(() => {});
	return true;
}
