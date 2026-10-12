// src/eval/runner.ts — runs a seed-pinned task list against one openai-compat
// endpoint (swarm specialists, the buckle front, any /v1). Errors land as
// honest incorrect rows with the error text — never dropped.
import type { Arm, Task, TaskResult } from "./types.ts";

export interface RunOpts {
	concurrency: number;
	timeout_ms: number;
	max_tokens: number;
	repeats: number;
}

interface ChatWire {
	choices?: { message?: { content?: string } }[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

/** One chat request → one graded row. */
export async function askOne(
	arm: Arm,
	task: Task,
	opts: RunOpts,
): Promise<TaskResult> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (arm.key) headers.authorization = `Bearer ${arm.key}`;
	const t0 = performance.now();
	try {
		const res = await fetch(`${arm.url}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: arm.model,
				messages: [
					{ role: "system", content: task.system },
					{ role: "user", content: task.prompt },
				],
				temperature: 0,
				max_tokens: opts.max_tokens,
				stream: false,
			}),
			signal: AbortSignal.timeout(opts.timeout_ms),
		});
		if (!res.ok) {
			const t = await res.text().catch(() => "");
			return fail(
				arm,
				task,
				`HTTP ${String(res.status)}: ${t.slice(0, 180)}`,
				performance.now() - t0,
			);
		}
		const wire = (await res.json()) as ChatWire;
		const text = (wire.choices?.[0]?.message?.content ?? "").trim();
		const u = wire.usage ?? {};
		return {
			task_id: task.id,
			shape: task.shape,
			arm: arm.name,
			repeat: 0,
			ok: task.check(text),
			latency_ms: Math.round(performance.now() - t0),
			tokens_in: u.prompt_tokens ?? 0,
			tokens_out: u.completion_tokens ?? 0,
			answer: text,
		};
	} catch (e) {
		return fail(
			arm,
			task,
			e instanceof Error ? e.message : String(e),
			performance.now() - t0,
		);
	}
}

/** Honest failure row (the call never silently vanishes). */
function fail(arm: Arm, task: Task, error: string, ms: number): TaskResult {
	return {
		task_id: task.id,
		shape: task.shape,
		arm: arm.name,
		repeat: 0,
		ok: false,
		error,
		latency_ms: Math.round(ms),
		tokens_in: 0,
		tokens_out: 0,
		answer: "",
	};
}

/** Bounded-concurrency sweep: all tasks × repeats, one row per result. */
export async function runArm(
	arm: Arm,
	tasks: Task[],
	opts: RunOpts,
	onRow?: (r: TaskResult) => void,
): Promise<TaskResult[]> {
	const out: TaskResult[] = [];
	const queue = tasks.flatMap((task) =>
		Array.from({ length: opts.repeats }, (_, repeat) => ({ task, repeat })),
	);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < queue.length) {
			const item = queue[next++] as (typeof queue)[number];
			const row = await askOne(arm, item.task, opts);
			row.repeat = item.repeat;
			out.push(row);
			onRow?.(row);
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, opts.concurrency) }, worker),
	);
	return out;
}

/** Arm availability probe: /models, then a 1-token chat ping as fallback. */
export async function ping(arm: Arm): Promise<boolean> {
	try {
		const r = await fetch(`${arm.url}/models`, {
			signal: AbortSignal.timeout(5000),
		});
		if (r.ok) return true;
	} catch {
		// fall through to the chat ping
	}
	try {
		const r = await fetch(`${arm.url}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: arm.model,
				max_tokens: 5,
				messages: [{ role: "user", content: "Reply READY" }],
			}),
			signal: AbortSignal.timeout(10000),
		});
		return r.ok;
	} catch {
		return false;
	}
}
