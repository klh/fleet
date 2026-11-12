import type { RunnerActor } from "../control/rights.ts";
import type { LeaseToken } from "../control/leases.ts";
import type { JobAction, JobSpec } from "../durable/contracts.ts";
import type { CredentialManager } from "./credentials.ts";

/** Trusted HOST dependencies; one opened job owns this captured execution epoch. */
export function captureExecutionAuthority(input: {
	runId: string;
	executorSid: string;
	token: LeaseToken;
	fence: (input: {
		runId: string;
		actor: RunnerActor;
		action?: JobAction;
	}) => Promise<void>;
	credentials: Pick<CredentialManager, "resolve">;
}) {
	const { runId, executorSid, fence, credentials } = input;
	const epoch = input.token.epoch;
	const key = (): string => {
		const credential = credentials.resolve(runId, epoch);
		if (!credential || credential.epoch !== epoch)
			throw new Error(
				"runner: no live credential for captured execution epoch",
			);
		return credential.key;
	};
	return {
		async authorize(action: JobAction, spec: Pick<JobSpec, "runId">) {
			if (spec.runId !== runId)
				throw new Error("runner: execution authority run mismatch");
			await fence({
				runId,
				action,
				actor: { sid: executorSid, scopes: [], leaseToken: { epoch } },
			});
		},
		key,
		transformHeaders(
			headers: Record<string, string | null>,
		): Record<string, string | null> {
			const kept = Object.entries(headers).filter(
				([name]) => name.toLowerCase() !== "authorization",
			);
			return { ...Object.fromEntries(kept), authorization: `Bearer ${key()}` };
		},
	};
}
