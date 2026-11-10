/**
 * pi-durable-workers — the durable unattended-run extension (W2901).
 *
 * ONE extension on @earendil-works/pi-durable bundling the W2888 build item:
 *   (1) wake tasks   — timer/poll/subscribe policies, hub-dark tolerant (startWake)
 *   (2) budget guards — step/tool-call caps + workers_finish convention
 *   (3) doom-loop    — observe@2 / block@3 / stop@6 with replay-safe counters
 *   (4) approvals    — durable doc + beforeTool gate + host decisions
 *   (5) uniform task — workers_task spawn/check/steer/cancel for child work
 *   (6) MCP attach   — remote servers attach as tools upstream (pi-mcp); this
 *                      extension treats them like any tool (gates/counters)
 *   (7) announce     — optional host-owned publisher
 *
 * The extension is pure data (tools/sections/hooks); side-effectful runtime
 * pieces (wake timers, announcer) start through `startWorkers`. v1 note:
 * hard-abort enforcement at the budget cap is host-side — the hooks demand
 * `workers_finish` and the host may abort past the cap.
 */

import type {
	Context,
	Extension,
	HookApi,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createLogger, type Logger } from "@klh/buckle/src/log";
import type { AnnounceOptions, Announcer } from "./announce.ts";
import {
	type ApprovalRequest,
	type ApprovalsWriter,
	approvalsBeforeTool,
	createApprovalsWriter,
} from "./approvals.ts";
import { budgetBeforeRequest, createFinishTool, DEFAULTS } from "./budget.ts";
import { ApprovalsDoc, WakeDoc, type WakePolicy } from "./docs.ts";
import {
	type DoomLadder,
	doomAfterTools,
	doomBeforeRequest,
	doomBeforeTool,
	foldRound,
} from "./doomloop.ts";
import { createWorkersTaskTool } from "./tasks.ts";
import { startWake, type WakeController, type WakeOptions } from "./wake.ts";

export {
	type AnnounceOptions,
	type Announcer,
	type AnnounceWorker,
	createAnnouncer,
} from "./announce.ts";
export { type ApprovalsWriter, createApprovalsWriter } from "./approvals.ts";
export { counters, createFinishTool, verdict } from "./budget.ts";
export {
	ApprovalsDoc,
	BudgetDoc,
	DoomDoc,
	WakeDoc,
	type WakePolicy,
} from "./docs.ts";
export { createWorkersTaskTool, type WorkersTaskHost } from "./tasks.ts";
export { startWake, type WakeController, type WakeOptions } from "./wake.ts";

export type DurableWorkersOptions = {
	readonly budget?: {
		readonly maxSteps?: number;
		readonly maxToolCalls?: number;
		readonly warnAtFraction?: number;
	};
	readonly doom?: DoomLadder;
	readonly approvals?: {
		/** Tools that require approval before every call (`*` = all). */
		readonly requireFor?: readonly string[];
		/** Bridge committed by the host: raise a pending request durably. */
		readonly onPending?: (
			req: ApprovalRequest,
			conversationId: string,
			context: Context,
		) => Promise<void>;
	};
	/** Surface finished runs (announce beat, cockpit activity). */
	readonly onFinish?: (
		finish: { summary: string; success: boolean },
		context: Context,
	) => void | Promise<void>;
	readonly fetchImpl?: typeof fetch;
	/** Shared logger seam (default `createLogger("workers")`). */
	readonly logger?: Logger;
};

/** The `pi-durable-workers` extension: tools, protocol section, and hooks. */
export function durableWorkers(
	options: DurableWorkersOptions = {},
): Extension<ToolRegistration> {
	const budget = { ...DEFAULTS, ...options.budget };
	const ladder = options.doom ?? { observe: 2, block: 3, stop: 6 };
	const log = options.logger ?? createLogger("workers");

	return defineExtension({
		name: "pi-durable-workers",
		tools: [
			createFinishTool({
				onFinish: async (finish, context) => {
					log[finish.success ? "info" : "warn"](
						`run finished: ${finish.success ? "success" : "failed"} — ${finish.summary}`,
					);
					await options.onFinish?.(finish, context);
				},
			}),
			createWorkersTaskTool(noRuntimeBridge),
		],
		sections: [
			{
				key: "workers-protocol",
				render: () =>
					[
						"You operate unattended under the workers protocol.",
						"- Budget: steps/tool calls are capped; you will be warned, then ordered to finish.",
						"- Call `workers_finish` when the brief is complete (summary + success).",
						"- Long work: `workers_task` spawn (deferred), check, steer, cancel.",
						"- Repeating an identical tool round is condemned: observe, then block, then stop.",
						...(process.env.PI_DURABLE_SEED_SPEEDY === "1"
							? [
									"Guest tools: rg searches contents, fd locates paths, bat reads bounded line ranges, sd makes scoped edits, jq inspects JSON, and eza lists files.",
									"With a working terminal, use fzf for interactive selection and ambr for reviewed cross-file edits.",
								]
							: []),
					].join("\n"),
			},
		],
		hooks: [
			hook(GenerationTask, {
				async beforeRequest(request, api, context) {
					const budgetResult = await budgetBeforeRequest(
						request,
						api,
						context,
						budget.maxSteps,
						budget.maxToolCalls,
						budget.warnAtFraction,
					);
					const doomResult = await doomBeforeRequest(
						budgetResult?.messages ?? request.messages,
						api,
						context,
						ladder,
					);
					if (!budgetResult && !doomResult) return undefined;
					return { messages: (doomResult ?? budgetResult ?? request).messages };
				},
				async afterTools(assistant, results, api, context) {
					const entry = await api.entry(assistant, context);
					await foldRound(api, countCalls(entry), context);
					return doomAfterTools(assistant, results, api, context);
				},
			}),
			hook(ToolTask, {
				async beforeTool(call, api, context) {
					const doomBlock = await doomBeforeTool(call, api, context, ladder);
					if (doomBlock?.block) {
						log.warn(
							`doom loop: blocked ${call.name} (identical round repeats)`,
						);
						return doomBlock;
					}
					return approvalsBeforeTool(call, api, context, async (req) => {
						log.warn(
							`approval required for ${req.tool} (request ${req.id} pending)`,
						);
						await options.approvals?.onPending?.(
							req,
							api.conversationId,
							context,
						);
					});
				},
			}),
		],
	});
}

function countCalls(entry: Awaited<ReturnType<HookApi["entry"]>>): number {
	let n = 0;
	for (const m of entry?.model ?? []) {
		if (m.role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content)
			if ((block as { type?: string })?.type === "toolCall") n += 1;
	}
	return n;
}

const noRuntimeBridge = {
	spawn: () =>
		Promise.resolve("unreported: spawn requires startWorkers() runtime"),
	check: () =>
		Promise.resolve("unreported: check requires startWorkers() runtime"),
	steer: () =>
		Promise.resolve("unreported: steer requires startWorkers() runtime"),
	cancel: () =>
		Promise.resolve("unreported: cancel requires startWorkers() runtime"),
};

// ---------- runtime ----------

export type WorkersRuntimeOptions = DurableWorkersOptions & {
	readonly conversationId: string;
	/** Fleet publishes inventory from the lease-owning controller. */
	readonly announcer?: Announcer;
};

export type WorkersRuntime = {
	readonly stop: () => void;
	readonly approvals: ApprovalsWriter;
	readonly announcer: Announcer | null;
	readonly addWakePolicy: (
		policy: WakePolicy,
		context: Context,
	) => Promise<void>;
	readonly beat: (state: string, task: string) => Promise<void>;
};

/** Boot the full runtime for one conversation: approvals config, wake timers, announce. */
export async function startWorkers(
	harness: import("@earendil-works/pi-durable").Harness,
	options: WorkersRuntimeOptions,
	context: Context,
): Promise<WorkersRuntime> {
	const conversationId = options.conversationId;
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation)
		throw new Error(`pi-durable-workers: no conversation ${conversationId}`);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const log = options.logger ?? createLogger("workers");
	log.info(`startWorkers booting for ${conversationId}`);

	// approvals: seed requireFor durably + writer bridged onto this harness
	const approvals = createApprovalsWriter(
		async (change, ctx) => {
			await conversation.commit(async (tx) => {
				const doc = (await tx.doc(ApprovalsDoc, conversationId)) as {
					requireFor: string[];
					requests: unknown[];
				};
				await change(doc as never, ctx);
			}, ctx);
		},
		async (ctx) => await harness.snapshot(ApprovalsDoc, conversationId, ctx),
	);
	if (options.approvals?.requireFor?.length)
		await approvals.requireFor(options.approvals.requireFor, context);

	// wake timers (restartable so addWakePolicy can reschedule)
	const wakeOptions: WakeOptions = { fetchImpl };
	let wake: WakeController = await startWake(
		harness,
		conversationId,
		context,
		wakeOptions,
	);

	const announcer = options.announcer ?? null;

	return {
		approvals,
		announcer,
		beat: async (state, task) => {
			await announcer?.beat(state, task);
		},
		addWakePolicy: async (policy, ctx) => {
			await conversation.commit(async (tx) => {
				const doc = (await tx.doc(WakeDoc, conversationId)) as {
					policies: WakePolicy[];
				};
				doc.policies = [
					...doc.policies.filter((p) => p.label !== policy.label),
					policy,
				];
			}, ctx);
			log.info(`wake policy ${policy.label} (${policy.kind}) added`);
			wake.stop();
			wake = await startWake(harness, conversationId, ctx, {
				...wakeOptions,
				logger: log,
			});
		},
		stop: () => {
			wake.stop();
			announcer?.stop();
			log.info("workers runtime stopped");
		},
	};
}

export type { AnnounceOptions };
