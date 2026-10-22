import type { LaneVerdict } from "./lane-liveness.ts";

export interface ExecutionClaim {
	project: string;
	id: string;
	state: string;
	owner_sid: string | null;
	result_sha: string | null;
	open_decisions?: number;
}
export interface ExecutionEvidence {
	project: string;
	item: string;
	sid: string;
	observedAt: number;
	process: boolean | null;
	lease: LaneVerdict;
	lifecycle: string | null;
	lifecycleAt: number | null;
	attempt: number | null;
}
export interface ArtifactEvidence {
	project: string;
	item: string;
	commit: string;
	stage: "completed" | "reviewed" | "review-blocked" | "landed";
	ts: number;
}

/** Ownership, harness presence and landed output are independent facts.
 * A transcript lease/PID/spend never establishes productive execution. */
export function workExecution(
	claim: ExecutionClaim,
	evidence: ExecutionEvidence | null,
	artifacts: readonly ArtifactEvidence[],
	observedAt: number,
) {
	const active = ["CLAIMED", "RUNNING"].includes(claim.state);
	const bound =
		evidence &&
		evidence.project === claim.project &&
		evidence.item === claim.id &&
		evidence.sid === claim.owner_sid &&
		evidence.observedAt === observedAt
			? evidence
			: null;
	let state = "unknown";
	if (claim.state === "PAUSED") state = "paused";
	else if (
		claim.state === "BLOCKED" ||
		(active && (claim.open_decisions ?? 0) > 0)
	)
		state = "blocked";
	else if (!active) state = claim.state === "DONE" ? "completed" : "inactive";
	else if (bound?.lifecycle === "PAUSED") state = "paused";
	else if (["PAUSE_REQUESTED", "RESUME_READY"].includes(bound?.lifecycle ?? ""))
		state = "transitioning";
	else if (bound?.process === true) state = "live-harness";
	else if (bound?.lease === "dead") state = "dead";
	const matches = artifacts.filter(
		(a) =>
			a.project === claim.project &&
			a.item === claim.id &&
			a.commit === claim.result_sha,
	);
	const latest = matches.sort((a, b) => b.ts - a.ts)[0] ?? null;
	return {
		state,
		observed_at: observedAt,
		source: bound ? "canonical-registry/process/lifecycle" : "work-claim-only",
		process_observed_at: bound?.observedAt ?? null,
		lease_liveness: bound?.lease ?? "unknown",
		lifecycle: bound?.lifecycle ?? null,
		lifecycle_observed_at: bound?.lifecycleAt ?? null,
		attempt: bound?.attempt ?? null,
		progress: latest ?? null,
	};
}

/** Distinct exact project+SID identities; one coordinator's many claims
 * never become many live workers. Counts describe evidence, not throughput. */
export function executionSummary(
	rows: readonly (ExecutionClaim & {
		execution: ReturnType<typeof workExecution>;
	})[],
) {
	const claims = rows.filter((r) => ["CLAIMED", "RUNNING"].includes(r.state));
	const owners = new Set(
		claims
			.filter((r) => r.owner_sid)
			.map((r) => `${r.project}\0${r.owner_sid}`),
	);
	const live = new Set(
		claims
			.filter((r) => r.execution.state === "live-harness")
			.map((r) => `${r.project}\0${r.owner_sid}`),
	);
	return {
		claims: claims.length,
		owners: owners.size,
		live_harnesses: live.size,
		paused: claims.filter((r) => r.execution.state === "paused").length,
		blocked: claims.filter((r) => r.execution.state === "blocked").length,
		dead: claims.filter((r) => r.execution.state === "dead").length,
		unknown: claims.filter((r) => r.execution.state === "unknown").length,
		transitioning: claims.filter((r) => r.execution.state === "transitioning")
			.length,
	};
}
