/**
 * pi-durable-workers — doom-loop ladder.
 *
 * Ports the OpenRouter doomLoop pattern (W2888): when a generation run
 * repeats the same tool round (same signature), escalate:
 *   observe @2  — append an observation note to the next request
 *   block   @3  — beforeTool blocks the repeated call with a reason
 *   stop    @6  — beforeRequest demands `workers_finish`
 *
 * Counters are task memos keyed by the previous round's signature —
 * checkpointed, replay-safe: a rerun after a crash sees the same counts.
 */

import type {
	Context,
	EntryRecord,
	HookApi,
	Message,
} from "@earendil-works/pi-durable";
import { bumpSteps, bumpToolCalls } from "./budget.ts";
import { roundSignature } from "./docs.ts";

export const DOOM_DEFAULTS = { observe: 2, block: 3, stop: 6 } as const;

const MEMO_LAST_SIG = "klh.workers.doom.lastSig";
const MEMO_REPEAT = "klh.workers.doom.repeat";

export type DoomLadder = {
	readonly observe: number;
	readonly block: number;
	readonly stop: number;
};

// ---------- round reading (from hook entry ids) ----------

/** Tool-call blocks of the round's assistant message: `{type:"toolCall", id, name, arguments}`. */
function callBlocks(
	entry: EntryRecord | undefined,
): Array<{ name: string; arguments: unknown }> {
	const out: Array<{ name: string; arguments: unknown }> = [];
	for (const m of entry?.model ?? []) {
		if (m.role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if ((block as { type?: string })?.type === "toolCall") {
				const b = block as { name?: string; arguments?: unknown };
				out.push({ name: String(b.name ?? "?"), arguments: b.arguments });
			}
		}
	}
	return out;
}

/** Text head of the round's result entries (toolResult message text + data fallback). */
function resultText(entry: EntryRecord | undefined): string {
	let text = "";
	for (const m of entry?.model ?? []) {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; text?: string; value?: string };
			if (b.type === "text") text += b.text ?? b.value ?? "";
			else if (b.type === "toolResult") text += b.text ?? "";
		}
	}
	if (!text && entry?.data !== undefined) text = JSON.stringify(entry.data);
	return text;
}

/** Fold the finished round (hook args) into a doom signature. */
export async function doomAfterTools(
	assistant: string,
	results: readonly string[],
	api: HookApi,
	context: Context,
): Promise<{ repeats: number; signature: string }> {
	const assistantEntry = await api.entry(assistant, context);
	const calls = callBlocks(assistantEntry);
	const resultEntries = await Promise.all(
		results.map((id) => api.entry(id, context)),
	);
	const sig = roundSignature(
		calls.map((c, i) => ({
			name: c.name,
			args: c.arguments,
			resultHead: resultText(resultEntries[i]),
		})),
	);
	const lastSig = await api.memo<string>(MEMO_LAST_SIG, context);
	if (lastSig === sig) {
		const repeats = ((await api.memo<number>(MEMO_REPEAT, context)) ?? 1) + 1;
		await api.memo(MEMO_REPEAT, repeats, context);
		return { repeats, signature: sig };
	}
	await api.memo(MEMO_LAST_SIG, sig, context);
	await api.memo(MEMO_REPEAT, 1, context);
	return { repeats: 1, signature: sig };
}

/** Called from `beforeTool`: block a call the ladder has condemned. */
export async function doomBeforeTool(
	_call: { name: string },
	api: HookApi,
	context: Context,
	ladder: DoomLadder = DOOM_DEFAULTS,
): Promise<{ block?: string } | undefined> {
	const lastSig = await api.memo<string>(MEMO_LAST_SIG, context);
	if (!lastSig) return undefined;
	const repeats = (await api.memo<number>(MEMO_REPEAT, context)) ?? 0;
	if (repeats >= ladder.block && repeats < ladder.stop) {
		return {
			block: `[doom-loop] this tool round has repeated ${repeats}× with identical results. Blocked. Change approach or call workers_finish.`,
		};
	}
	return undefined;
}

/** Called from `beforeRequest`: appends observation/stop notes per ladder rung. */
export async function doomBeforeRequest(
	request: { readonly messages: readonly Message[] },
	api: HookApi,
	context: Context,
	ladder: DoomLadder = DOOM_DEFAULTS,
): Promise<{ readonly messages: readonly Message[] } | undefined> {
	const repeats = (await api.memo<number>(MEMO_REPEAT, context)) ?? 0;
	if (repeats < ladder.observe) return undefined;
	const note =
		repeats >= ladder.stop
			? `[doom-loop] STOP: ${repeats} identical rounds. Do not retry. Call workers_finish with your findings now.`
			: `[doom-loop] observed: the last ${repeats} tool rounds produced identical results. Break the loop: change inputs, pick another approach, or call workers_finish.`;
	const noteMessage = {
		role: "user",
		content: note,
		timestamp: Date.now(),
	} as Message;
	return { messages: [...request.messages, noteMessage] };
}

/** Shared step/call folding for the budget hooks; exported for tests. */
export async function foldRound(
	api: HookApi,
	roundToolCalls: number,
	context: Context,
): Promise<{ steps: number; toolCalls: number }> {
	const steps = await bumpSteps(api, context);
	const toolCalls = await bumpToolCalls(api, roundToolCalls, context);
	return { steps, toolCalls };
}
