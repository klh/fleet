// rights.ts — W2869.2: the 6-action authorization vocabulary (root
// #117699/#117705: open | read | submit | resume | abort | execute).
// Human/lane control actions ride buckle runner scopes; EXECUTE rides
// NOTHING user-shaped — it validates the executor's CURRENT LEASE TOKEN
// (autonomous turns carry no user scopes; root #117699), fencing every
// model request and tool boundary. The authorizer is injected so a
// store-server adapter can swap the default (keyring scopes) without
// touching this contract.
import { fenceCheck, type LeaseToken } from "./leases.ts";
import type { RunnerStore } from "./store.ts";
import { hasScope } from "@klh/buckle/src/gov/scopes.ts";

export type JobAction =
	| "open"
	| "read"
	| "submit"
	| "resume"
	| "abort"
	| "execute";

export const RUNNER_SCOPES = {
	control: "buckle:runner:WRITE_",
	read: "buckle:runner:READ_",
} as const;

const ACTION_SCOPES: Readonly<Record<Exclude<JobAction, "execute">, string>> = {
	open: RUNNER_SCOPES.control,
	submit: RUNNER_SCOPES.control,
	resume: RUNNER_SCOPES.control,
	abort: RUNNER_SCOPES.control,
	read: RUNNER_SCOPES.read,
};

/** The actor a control action rides: keyring scopes for humans/lanes,
 *  a lease token for the executor. */
export interface RunnerActor {
	sid: string;
	scopes: readonly string[];
	leaseToken?: LeaseToken;
}

export class RunnerAuthError extends Error {}

export interface RunnerAuthorizer {
	authorize(
		action: JobAction,
		input: { runId: string; actor: RunnerActor },
	): Promise<void>;
}

/** Default authorizer: runner scopes gate the five control actions; the
 *  execute action validates the executor's CURRENT LEASE TOKEN against
 *  the shared lease table (fenceCheck doubles as the heartbeat). Throws
 *  RunnerAuthError — callers render the denial, never fake success.
 *  TRUST BOUNDARY: actor.scopes/leaseToken are HOST-RESOLVED (keyring,
 *  minted lease) — an API adapter must derive them from the authenticated
 *  credential, never read them from request JSON. */
export const makeRunnerAuthorizer = (deps: {
	store: RunnerStore;
	now?: () => number;
}): RunnerAuthorizer => {
	const now = deps.now ?? (() => Date.now());
	return {
		async authorize(action, { runId, actor }) {
			if (action === "execute") {
				if (!actor.leaseToken) {
					throw new RunnerAuthError(
						`runner: denied execute — no lease token (${actor.sid})`,
					);
				}
				const fence = fenceCheck(deps.store, runId, actor.leaseToken, now());
				if (!fence.ok) {
					throw new RunnerAuthError(`runner: denied execute — ${fence.reason}`);
				}
				return;
			}
			const required = ACTION_SCOPES[action];
			if (!hasScope([...actor.scopes], required)) {
				throw new RunnerAuthError(
					`runner: denied ${action} — requires ${required} (actor ${actor.sid})`,
				);
			}
		},
	};
};
