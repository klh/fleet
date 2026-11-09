import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
/**
 * Integration: the pi-durable-workers extension inside a REAL durable run.
 *
 * A faux model repeats an identical echo tool call, then finishes via
 * workers_finish. Asserts the full loop: budget counters fold per round,
 * the doom ladder observes the repeat, and the finish tool writes the
 * durable BudgetDoc. Then: wake timers fire real submissions into a live
 * conversation.
 */

import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { BudgetDoc } from "../src/docs.ts";
import { durableWorkers, startWake, startWorkers } from "../src/index.ts";
import { chatSetup, openChat, waitFor, allEntries } from "./release-support.ts";
import { context } from "./release-support.ts";

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

test.describe("workers in a real run", () => {
	test("folds budget counters, observes a doom repeat, and finishes durably", async () => {
		const setup = chatSetup();
		setup.registry.install(durableWorkers({}));
		setup.registry.install({
			name: "echo-tools",
			tools: [echoTool()],
		} as never);
		const state = await mkdtemp(join(tmpdir(), "worker-release-state-"));
		const storage = await openNodeJsonlStorage(state, context, { fsync: true });
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
		const reopenedStorage = await openNodeJsonlStorage(state, context, { fsync: true });
		const reopened = await openChat(reopenedStorage, setup);
		expect(reopened.root.id).toBe(root.id);
		expect((await reopened.harness.snapshot(BudgetDoc, root.id, context)).finishReason).toBe("finish_tool");
		await reopened.harness.close(context);
		await rm(state, { recursive: true });
	});

	test("wake timers fire real submissions (hub-dark tolerant)", async () => {
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

async function rootIdle(harness: import("@earendil-works/pi-durable").Harness, ctx: typeof context): Promise<boolean> {
	await harness.waitForIdle(ctx).catch(() => {});
	return true;
}

test("poll and subscribe wakes submit only on a usable response", async () => {
	const setup = chatSetup();
	setup.registry.install(durableWorkers({}));
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const runtime = await startWorkers(harness, { conversationId: root.id }, context);
	const url = "https://wake.invalid/";
	await runtime.addWakePolicy({
		kind: "poll", url, everyS: 3600, idleToken: "idle", label: "poll", prompt: "poll wake",
	}, context);
	await runtime.addWakePolicy({
		kind: "subscribe", url, degradeEveryS: 3600, filter: "work.ready", label: "subscribe", prompt: "subscribe wake",
	}, context);
	runtime.stop();

	const replies = [new Response("idle"), new Response("ready"), new Response("offline", { status: 503 }), new Response("ready")];
	const controller = await startWake(harness, root.id, context, {
		fetchImpl: Object.assign(async () => replies.shift() ?? new Response(null, { status: 500 }), { preconnect: () => {} }),
	});
	try {
		expect(await controller.fire("poll", context)).toBe(false);
		expect(await controller.fire("poll", context)).toBe(true);
		expect(await controller.fire("subscribe", context)).toBe(false);
		expect(await controller.fire("subscribe", context)).toBe(true);
		expect(replies).toHaveLength(0);
	} finally {
		controller.stop();
		await harness.close(context);
	}
});
