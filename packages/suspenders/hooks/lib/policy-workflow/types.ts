// hooks/lib/policy-workflow/types.ts — W462 corporate policy workflow shared
// types and transition tables. Data-only module so machine.ts, store.ts,
// health-policy.ts and bin/policy-workflow.ts share one shape without import
// cycles. Spec: toto-gpt.md "Separate three state machines" — assessment,
// remediation and deployment attestation are separate records: an approved
// lane does not make the service conforming, a merged patch does not prove
// deployment, and a deployment check can fail after a valid merge.

export const ASSESSMENT_STATES = [
	"pending",
	"assessing",
	"conforming",
	"gap",
	"unknown",
	"stale",
] as const;
export type AssessmentState = (typeof ASSESSMENT_STATES)[number];

export const REMEDIATION_STATES = [
	"proposed",
	"approved",
	"claimed",
	"in-review",
	"merged",
	"cancelled",
] as const;
export type RemediationState = (typeof REMEDIATION_STATES)[number];

export const ATTESTATION_STATES = ["pending", "verified", "failed", "expired"] as const;
export type AttestationState = (typeof ATTESTATION_STATES)[number];

export type RecordKind = "assessment" | "remediation" | "attestation";

/** Allowed transitions, per record kind. Anything absent is refused. */
export const TRANSITIONS: Record<RecordKind, Readonly<Record<string, readonly string[]>>> = {
	assessment: {
		pending: ["assessing"],
		assessing: ["conforming", "gap", "unknown"],
		// invalidation: tracked inputs changed or live evidence expired
		conforming: ["stale"],
		gap: ["stale"],
		unknown: ["stale"],
		stale: ["assessing"],
	},
	remediation: {
		proposed: ["approved", "cancelled"],
		approved: ["claimed", "cancelled"],
		claimed: ["in-review", "cancelled"],
		"in-review": ["merged", "cancelled"],
		merged: [],
		cancelled: [],
	},
	attestation: {
		pending: ["verified", "failed"],
		// re-attest after remediation or configuration change
		verified: ["expired"],
		failed: ["pending"],
		expired: ["pending"],
	},
};

export function canTransition(kind: RecordKind, from: string, to: string): boolean {
	return TRANSITIONS[kind][from]?.includes(to) ?? false;
}

/** Assessment key — one record per project/org/service/policy. */
export interface AssessmentKey {
	project: string;
	orgId: string;
	serviceId: string;
	policyId: string;
}

export interface AssessmentRecord extends AssessmentKey {
	policyVersion: string;
	state: AssessmentState;
	/** assessor verdict; may be finer-grained than the state (e.g. partial) */
	verdict: string | null;
	/** JSON evidence array tied to inputsHash */
	evidence: string | null;
	/** sha256 over the policy-relevant inputs this evidence was derived from */
	inputsHash: string;
	leaseSid: string | null;
	leaseExpires: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface RemediationRecord {
	project: string;
	id: string;
	orgId: string;
	serviceId: string;
	policyId: string;
	/** assessment key this gap came from */
	orgServicePolicyKey: string;
	/** sha256 over the canonical proposal payload — decisions bind to it */
	proposalHash: string;
	/** JSON proposal: affected service, observed gap, scope, acceptance */
	proposal: string;
	state: RemediationState;
	claimedBy: string | null;
	decisionRef: string | null;
	/** the ONE authorized remediation work item (work graph id) once an
	 *  approval minted it — idempotency anchor for concurrent approvers */
	workId: string | null;
	createdAt: number;
	updatedAt: number;
}

export type DecisionAction = "approve" | "defer" | "exception";

export interface DecisionRecord {
	project: string;
	id: string;
	remediationId: string;
	action: DecisionAction;
	actor: string;
	/** the exact proposal digest the actor signed off on */
	proposalHash: string;
	/** exception expiry (ms epoch) — mandatory policy is never silently waived */
	expiresAt: number | null;
	decidedAt: number;
}

export interface AttestationRecord {
	project: string;
	id: string;
	orgId: string;
	serviceId: string;
	policyId: string;
	/** deployment instance/release scope — source conformance is not this */
	instance: string;
	state: AttestationState;
	/** JSON evidence from the deployed-wiring check */
	evidence: string | null;
	verifiedAt: number | null;
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}
