// child-delegation.ts — W2977: the ONE host-side door a Pi Durable
// supervisor composes to delegate a child through Fleet admission: reserve
// the child's budget against the parent allowance (aggregate pre-start cap
// — the concurrent-wave gate), admit through the W2973.1 ledger (stable
// child identity, route allowlist, replay-safe controller admission), and
// reconcile the reservation on the terminal receipt (close or fenced
// cancel). The door never carries parent authority: the actor is
// host-resolved (trust boundary rides the host credential, never the
// supervisor's payload), the child gets its own derived runId, and the
// brief is the only context the child sees.
import { releaseChildBudget, reserveChildBudget } from "./child-budget.ts";
import { admitChildRun, type ChildRoute } from "./child-admission.ts";
import { cancelChildRun, completeChildRun } from "./child-tracking.ts";
import type { RunnerController } from "./controller.ts";
import type { RunnerActor } from "./rights.ts";
import type { RunnerStore } from "./store.ts";

export interface DelegateDeps {
	store: RunnerStore;
	controller: Pick<RunnerController, "admit" | "abort">;
	/** Host-resolved actor of the calling supervisor (trust boundary rides
	 *  the host credential, never the supervisor's payload). */
	actor: RunnerActor;
	routes: readonly ChildRoute[];
	bounds?: { maxChildren?: number; maxDepth?: number };
	now?: () => number;
}

export interface DelegateInput {
	parentRunId: string;
	supervisorSid: string;
	childKey: string;
	depth?: number;
	kind: "coding" | "design" | "knowledge";
	brief: string;
	route?: ChildRoute;
	autoPark?: boolean;
	/** Reservation size for this child (the in/out/cached estimate the
	 *  wave reserves before admitting). */
	tokens: { in: number; out: number; cached: number };
	/** The parent's delegated token allowance (in + out measure). */
	maxTokens: number;
}

export async function delegateChildRun(
	deps: DelegateDeps,
	input: DelegateInput,
): Promise<{
	runId: string;
	token: import("./leases.ts").LeaseToken;
	replayed: boolean;
	reservationReplayed: boolean;
}> {
	const reservation = reserveChildBudget(deps.store, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		tokens: input.tokens,
		at: deps.now?.() ?? Date.now(),
		maxTokens: input.maxTokens,
	});
	const admission = await admitChildRun(deps, {
		parentRunId: input.parentRunId,
		supervisorSid: input.supervisorSid,
		childKey: input.childKey,
		depth: input.depth,
		kind: input.kind,
		route: input.route,
		brief: input.brief,
		autoPark: input.autoPark,
	});
	return {
		runId: admission.runId,
		token: admission.token,
		replayed: admission.replayed,
		reservationReplayed: reservation.replayed,
	};
}

/** Reconcile on terminal completion: land the result receipt (idempotent,
 *  drift-refusing), then release the child's reservation so the freed
 *  budget returns to the wave. Order matters — the release refuses until
 *  the receipt has settled. */
export async function closeChildRun(
	deps: DelegateDeps,
	input: {
		parentRunId: string;
		childKey: string;
		state: "done" | "failed";
		at: number;
		tokens: { in: number; out: number; cached: number };
		artifacts?: { path: string; digest: string; bytes: number }[];
		reason?: string;
	},
): Promise<{ replayed: boolean; released: boolean }> {
	const complete = await completeChildRun(deps.store, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		state: input.state,
		at: input.at,
		tokens: input.tokens,
		artifacts: input.artifacts,
		reason: input.reason,
	});
	const release = releaseChildBudget(deps.store, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
	});
	return { replayed: complete.replayed, released: release.released };
}

/** The fenced-cancellation path: best-effort controller abort, an aborted
 *  zero-spend receipt, then the reservation release — the wave gets its
 *  budget back and the receipt is the truth carrier. */
export async function revokeChildRun(
	deps: DelegateDeps,
	input: {
		parentRunId: string;
		childKey: string;
		at: number;
		reason?: string;
	},
): Promise<{ replayed: boolean; released: boolean }> {
	const cancel = await cancelChildRun(deps, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		at: input.at,
		reason: input.reason,
	});
	const release = releaseChildBudget(deps.store, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
	});
	return { replayed: cancel.replayed, released: release.released };
}
