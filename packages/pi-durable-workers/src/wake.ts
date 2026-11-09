/**
 * pi-durable-workers — wake tasks.
 *
 * Executor-side timers that submit turns into a durable conversation when a
 * policy fires. Cron/event/user are wake POLICIES inside the brief, not
 * runtime modes. Hub-dark tolerant: poll/subscribe wakes that cannot reach
 * the plane back off and stay silent — timers always run locally.
 *
 * Fires land as `input` submissions (`followUp` when busy, start when idle)
 * so they join the brief-driven loop instead of interrupting a run.
 */

import type { Conversation, Harness } from "@klh/pi-durable";
import type { Context } from "@klh/pi-durable";
import { createLogger, type Logger } from "@klh/buckle/src/log";
import { WakeDoc, type WakePolicy, type WakeState } from "./docs.ts";

export type WakeOptions = {
	/** Jitter fraction applied to every timer (default 0.1). */
	readonly jitter?: number;
	/** Fetch used by poll wakes (injectable for tests; default globalThis.fetch). */
	readonly fetchImpl?: typeof fetch;
	/** Shared logger seam (default `createLogger("workers.wake")`). */
	readonly logger?: Logger;
};

export type WakeController = {
	readonly stop: () => void;
	/** Force an immediate fire attempt of one policy by label. */
	readonly fire: (label: string, context: Context) => Promise<boolean>;
};

const DEFAULT_JITTER = 0.1;

export async function startWake(
	harness: Harness,
	conversationId: string,
	context: Context,
	options: WakeOptions = {},
): Promise<WakeController> {
	const jitter = options.jitter ?? DEFAULT_JITTER;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const log = options.logger ?? createLogger("workers.wake");
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) throw new Error(`pi-durable-workers: no conversation ${conversationId}`);
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let stopped = false;

	async function fire(policy: WakePolicy, context: Context): Promise<boolean> {
		if (stopped) return false;
		const wake = (await harness.snapshot(WakeDoc, conversationId, context)) ?? (WakeDoc.definition.initial() as WakeState);
		if (wake.firing[policy.label]) return false;
		await markFiring(conversation, policy.label, true, context);
		try {
			let shouldWake = true;
			let detail = "";
			if (policy.kind === "poll") {
				const probe = await probe(policy.url, policy.idleToken, fetchImpl);
				shouldWake = probe.awake;
				detail = probe.detail;
			} else if (policy.kind === "subscribe" && policy.url) {
				// v1: subscribes poll their plane endpoint; a true WS subscribe lands with W2886.
				const probe = await probe(policy.url, undefined, fetchImpl);
				shouldWake = probe.awake;
				detail = probe.detail;
			}
			if (shouldWake) {
				const content = detail ? `${policy.prompt}\n\n(wake detail: ${detail})` : policy.prompt;
				await conversation.submit({ type: "input", content, whenBusy: "followUp" }, context);
				log.info(`wake ${policy.label} (${policy.kind}) fired`);
			} else {
				log.debug(`wake ${policy.label} (${policy.kind}) held: ${detail || "no signal"}`);
			}
			return shouldWake;
		} catch (e) {
			// hub-dark: the wake stays silent; the next tick retries with fresh jitter
			log.warn(`wake ${policy.label} submit failed, silent retry next tick: ${String((e as Error)?.message ?? e)}`);
			return false;
		} finally {
			await markFiring(conversation, policy.label, false, context).catch(() => {});
		}
	}

	function schedule(policy: WakePolicy, context: Context): void {
		const base = policy.kind === "subscribe" ? policy.degradeEveryS : policy.everyS;
		const ms = Math.max(250, base * 1000 * (1 + (Math.random() - 0.5) * 2 * jitter));
		const t = setTimeout(() => {
			if (stopped) return;
			void fire(policy, context).finally(() => schedule(policy, context));
		}, ms);
		timers.add(t);
		t.unref?.();
	}

	async function markFiring(conversation: Conversation, label: string, on: boolean, context: Context): Promise<void> {
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(WakeDoc, conversationId);
			const firing = { ...doc.firing } as Record<string, true | undefined>;
			if (on) firing[label] = true;
			else delete firing[label];
			(doc as { firing: Record<string, true | undefined> }).firing = firing;
			if (!on) (doc as { lastFire: Record<string, number> }).lastFire[label] = Date.now();
		}, context);
	}

	const snapshot =
		((await harness.snapshot(WakeDoc, conversationId, context)) as WakeState | undefined) ??
		(WakeDoc.definition.initial() as WakeState);
	log.info(`wake scheduling ${snapshot.policies.length} policies`);
	for (const policy of snapshot.policies) schedule(policy, context);

	return {
		stop: () => {
			stopped = true;
			for (const t of timers) clearTimeout(t);
			timers.clear();
		},
		fire: async (label: string, context: Context) => {
			const wake =
				((await harness.snapshot(WakeDoc, conversationId, context)) as WakeState | undefined) ??
				(WakeDoc.definition.initial() as WakeState);
			const policy = wake.policies.find((p) => p.label === label);
			return policy ? fire(policy, context) : false;
		},
	};
}

async function probe(
	url: string,
	idleToken: string | undefined,
	fetchImpl: typeof fetch,
): Promise<{ awake: boolean; detail: string }> {
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return { awake: false, detail: `probe ${res.status}` };
		const body = (await res.text()).slice(0, 4096);
		if (idleToken && body.includes(idleToken)) return { awake: false, detail: "idle" };
		return { awake: true, detail: body.slice(0, 400) };
	} catch (e) {
		return { awake: false, detail: `probe failed: ${String((e as Error)?.message ?? e)}` };
	}
}
