/**
 * pi-durable-workers — uniform task tool.
 *
 * One model-facing tool for background work: spawn a child generation
 * (pi-durable's outbound-ask shape: child task `waiting` on the parent via
 * the scheduler's on:/policy machinery), check its state, or steer it.
 * Deferred results = cross-hub asks (W2888): the child runs to a terminal
 * state while the parent's round completes; the next turn sees the outcome
 * injected at the turn boundary (queued followUp submission).
 */

import { bool, lit, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { defineTool } from "@klh/pi-durable";
import type { ToolRegistration } from "@klh/pi-durable";
import type { Context } from "@klh/pi-durable";

const schema = obj({
	action: union([lit("spawn"), lit("check"), lit("steer"), lit("cancel")], {
		description: "spawn: start background work; check: read its state; steer: send it a mid-run instruction; cancel: abort it.",
	}),
	prompt: opt(str({ description: "spawn/steer: the instruction for the background worker." })),
	label: opt(str({ description: "spawn: short label for the work (defaults to a counter)." })),
	taskId: opt(str({ description: "check/steer/cancel: the background task id previously returned." })),
	awaitResult: opt(bool({ description: "spawn: wait for completion in this call (default false — deferred)." })),
});

export type WorkersTaskInput = Static<typeof schema>;

export type WorkersTaskHost = {
	/** Spawn a child generation owned by the current task; returns its task id. */
	readonly spawn: (prompt: string, label: string, awaitResult: boolean, context: Context) => Promise<string>;
	/** Read a task's state (`running/waiting/done/failed/aborted/unknown`). */
	readonly check: (taskId: string, context: Context) => Promise<string>;
	/** Steer a running background conversation. */
	readonly steer: (taskId: string, instruction: string, context: Context) => Promise<string>;
	/** Abort-mark a background task. */
	readonly cancel: (taskId: string, context: Context) => Promise<string>;
};

export function createWorkersTaskTool(host: WorkersTaskHost): ToolRegistration<typeof schema> {
	return defineTool({
		name: "workers_task",
		description:
			"Manage background work: spawn a child worker (deferred by default — you get a task id and its result lands at your next turn boundary), check its state, steer it mid-run, or cancel it.",
		parameters: schema,
		async execute(args: WorkersTaskInput, api, context) {
			switch (args.action) {
				case "spawn": {
					if (!args.prompt) return err("spawn requires `prompt`");
					const label = args.label ?? `bg-${api.callId.slice(0, 6)}`;
					const id = await host.spawn(args.prompt, label, args.awaitResult === true, context);
					return ok(args.awaitResult === true ? `background work ${id} completed` : `background work started: ${id}`, {
						taskId: id,
						deferred: args.awaitResult !== true,
					});
				}
				case "check": {
					if (!args.taskId) return err("check requires `taskId`");
					return ok(`task ${args.taskId}: ${await host.check(args.taskId, context)}`);
				}
				case "steer": {
					if (!args.taskId || !args.prompt) return err("steer requires `taskId` and `prompt`");
					return ok(await host.steer(args.taskId, args.prompt, context));
				}
				case "cancel": {
					if (!args.taskId) return err("cancel requires `taskId`");
					return ok(await host.cancel(args.taskId, context));
				}
			}
		},
	});
}

function ok(text: string, details?: Record<string, unknown>) {
	return { output: [{ type: "text" as const, text }], details: (details ?? { ok: true }) as never };
}
function err(text: string) {
	return { output: [{ type: "text" as const, text: `error: ${text}` }], details: { ok: false } as never };
}
