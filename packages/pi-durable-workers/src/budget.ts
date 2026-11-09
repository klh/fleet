/**
 * pi-durable-workers — budget guards + finish-tool convention.
 *
 * Ports the stopWhen pattern table (W2888): step/tool-call caps for
 * unattended runs, with a `workers_finish` tool as the graceful exit.
 * Counters are task memos — checkpointed and replay-safe by construction.
 *
 * Ladder: at the warn fraction the next request appends a steer note; at the
 * hard cap it appends a stop instruction demanding `workers_finish`. A
 * `beforeRequest` hook cannot abort a run (abort belongs to the host), so
 * the hard cap relies on the finish convention; `startWorkers` enforces a
 * final watchdog abort past `hardAbortFactor` × cap.
 */

import { bool, obj, str, type Static } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import type { HookApi, Message, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/pi-durable";
import { BudgetDoc } from "./docs.ts";

export const DEFAULTS = {
	maxSteps: 40,
	maxToolCalls: 200,
	warnAtFraction: 0.8,
} as const;

export type BudgetCounters = { steps: number; toolCalls: number };

/** Memo names (task-scoped, checkpointed → replay-safe counters). */
export const MEMO_STEPS = "klh.workers.steps";
export const MEMO_CALLS = "klh.workers.toolCalls";

/** Read (or seed) the counters for this task. */
export async function counters(api: HookApi, context: Context): Promise<BudgetCounters> {
	const steps = (await api.memo<number>(MEMO_STEPS, context)) ?? 0;
	const calls = (await api.memo<number>(MEMO_CALLS, context)) ?? 0;
	return { steps, toolCalls: calls };
}

export async function bumpSteps(api: HookApi, context: Context): Promise<number> {
	const next = ((await api.memo<number>(MEMO_STEPS, context)) ?? 0) + 1;
	await api.memo(MEMO_STEPS, next, context);
	return next;
}

export async function bumpToolCalls(api: HookApi, by: number, context: Context): Promise<number> {
	const next = ((await api.memo<number>(MEMO_CALLS, context)) ?? 0) + by;
	await api.memo(MEMO_CALLS, next, context);
	return next;
}

export type BudgetVerdict = "ok" | "warn" | "stop";

export function verdict(c: BudgetCounters, maxSteps: number, maxToolCalls: number, warnAt: number): BudgetVerdict {
	const stepFrac = maxSteps > 0 ? c.steps / maxSteps : 0;
	const callFrac = maxToolCalls > 0 ? c.toolCalls / maxToolCalls : 0;
	if (c.steps >= maxSteps || c.toolCalls >= maxToolCalls) return "stop";
	if (stepFrac >= warnAt || callFrac >= warnAt) return "warn";
	return "ok";
}

/** `beforeRequest` hook body: appends the steer/stop note for THIS request only. */
export async function budgetBeforeRequest(
	request: { readonly messages: readonly Message[] },
	api: HookApi,
	context: Context,
	maxSteps = DEFAULTS.maxSteps,
	maxToolCalls = DEFAULTS.maxToolCalls,
	warnAt = DEFAULTS.warnAtFraction,
): Promise<{ readonly messages: readonly Message[] } | undefined> {
	const c = await counters(api, context);
	const v = verdict(c, maxSteps, maxToolCalls, warnAt);
	if (v === "ok") return undefined;
	const note =
		v === "warn"
			? `[budget] approaching cap (steps ${c.steps}/${maxSteps}, tool calls ${c.toolCalls}/${maxToolCalls}) — converge now.`
			: `[budget] HARD CAP reached (steps ${c.steps}/${maxSteps}, tool calls ${c.toolCalls}/${maxToolCalls}) — stop working and call workers_finish with a summary NOW.`;
	const noteMessage = { role: "user", content: note, timestamp: Date.now() } as Message;
	return { messages: [...request.messages, noteMessage] };
}

export type FinishInput = Static<typeof finishSchema>;

const finishSchema = obj({
	summary: str({ description: "Final summary of the unattended run." }),
	success: bool({ description: "Whether the run achieved its brief." }),
});

export type FinishToolOptions = {
	/** Host-side hook on finish (announce/cockpit surface). */
	readonly onFinish?: (finish: { summary: string; success: boolean }, context: Context) => void | Promise<void>;
};

/** The `workers_finish` tool: the graceful exit for unattended runs. */
export function createFinishTool(options: FinishToolOptions = {}): ToolRegistration<typeof finishSchema> {
	return defineTool({
		name: "workers_finish",
		description:
			"Finish this unattended run. Call when the brief is complete or a budget stop was demanded. Pass a summary and whether the run succeeded.",
		parameters: finishSchema,
		async execute(args: FinishInput, api, context) {
			await api.commit(async (tx) => {
				const doc = (await tx.doc(BudgetDoc, api.conversationId)) as {
					finishedAt?: number;
					finishReason?: string;
				};
				doc.finishedAt = Date.now();
				doc.finishReason = "finish_tool";
			}, context);
			await options.onFinish?.({ summary: args.summary, success: args.success }, context);
			return {
				output: [{ type: "text", text: `Recorded finish. ${args.summary}` }],
				details: { finished: true, success: args.success },
			};
		},
	});
}
