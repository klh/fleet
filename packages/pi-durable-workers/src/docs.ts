/**
 * pi-durable-workers — persistent documents for unattended runs.
 *
 * All state lives in defineDoc documents so it survives restarts (SQLite WAL
 * reopen-resume) and replays safely: counters checkpoint with the task, and
 * approval decisions are durable facts, not process memory.
 *
 * [klh-fleet] fleet-authored (W2901); pattern provenance: W2888 map
 * (@see docs/design/pi/fleet-cockpit-tui.md pattern table).
 */

import { defineDoc } from "@klh/pi-durable";

// ---------- wake policies ----------
/** One wake source: timer (every N s), poll (interval + probe descriptor), or subscribe (plane event filter). */
export type WakePolicy =
	| { readonly kind: "timer"; readonly everyS: number; readonly prompt: string; readonly label: string }
	| {
			readonly kind: "poll";
			readonly everyS: number;
			readonly url: string;
			readonly prompt: string;
			readonly label: string;
			/** Response body fragment that means "nothing to do" (skip waking). */
			readonly idleToken?: string;
	  }
	| {
			readonly kind: "subscribe";
			readonly filter: string;
			readonly prompt: string;
			readonly label: string;
			/** v1: subscribes degrade to a poll of `url` every `degradeEveryS` (hub-dark tolerant). */
			readonly url?: string;
			readonly degradeEveryS: number;
	  };

/** Wake policies for one conversation, with per-policy last-fire bookkeeping. */
export type WakeState = {
	readonly policies: readonly WakePolicy[];
	readonly lastFire: Readonly<Record<string, number>>;
	/** Set while a fire is in flight, so a slow wake never double-fires. */
	readonly firing: Readonly<Record<string, true>>;
};

export const WakeDoc = defineDoc<WakeState>({
	kind: "klh.workers.wake",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ policies: [], lastFire: {}, firing: {} }),
	checkpointWhen: (value) => Object.keys(value.firing).length === 0,
});

// ---------- budget guards ----------
/** Per-run spend counters, checkpointed with the generation task via memos (replay-safe). */
export type BudgetState = {
	readonly maxSteps?: number;
	readonly maxToolCalls?: number;
	readonly warnAtFraction?: number;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly finishReason?: "finish_tool" | "budget_hard" | "abort" | "answer";
};

export const BudgetDoc = defineDoc<BudgetState>({
	kind: "klh.workers.budget",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ startedAt: Date.now() }),
	checkpointWhen: (value) => value.finishedAt !== undefined,
});

// ---------- doom-loop ladder ----------
/** Consecutive-identical-round counter per tool signature. Ladder: observe@2 → block@3 → stop@6 (OpenRouter defaults). */
export type DoomState = {
	readonly thresholds: { readonly observe: number; readonly block: number; readonly stop: number };
};

export const DoomDoc = defineDoc<DoomState>({
	kind: "klh.workers.doom",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ thresholds: { observe: 2, block: 3, stop: 6 } }),
	checkpointWhen: () => true,
});

// ---------- approvals ----------
/** A durable approval request; decisions survive restarts because they are committed facts. */
export type ApprovalRequest = {
	readonly id: string;
	readonly tool: string;
	readonly argsPreview: string;
	readonly at: number;
	readonly status: "pending" | "approved" | "denied";
	readonly decidedAt?: number;
};

export type ApprovalsState = {
	readonly requests: readonly ApprovalRequest[];
	/** Tools that always require approval; `*` matches everything. */
	readonly requireFor: readonly string[];
};

export const ApprovalsDoc = defineDoc<ApprovalsState>({
	kind: "klh.workers.approvals",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ requests: [], requireFor: [] }),
	checkpointWhen: (value) => value.requests.every((r) => r.status !== "pending"),
});

/** Stable signature of a tool round, for doom counting: name + args + result head. */
export function roundSignature(calls: readonly { name: string; args: unknown; resultHead: string }[]): string {
	const parts = calls
		.map((c) => `${c.name}:${stableStringify(c.args)}:${c.resultHead.slice(0, 200)}`)
		.sort()
		.join("|");
	return hash32(parts).toString(36);
}

/** FNV-1a 32-bit; stable across restarts (unlike platform hash()). */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Deterministic JSON stringify for signatures (key-sorted). */
export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
