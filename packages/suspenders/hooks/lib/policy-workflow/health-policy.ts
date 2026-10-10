// hooks/lib/policy-workflow/health-policy.ts — W462 one-policy prototype:
// the corporate health policy from toto-gpt.md ("independent API health
// services"). Classifies a service's deployment against the requirement that
// every deployed API service has an independently supervised health reporter.
// Verdicts: conforming | gap | partial | unknown. A partial verdict still
// maps to assessment state "gap" — the state machine keeps coarse states,
// the verdict keeps the finer grain. Evidence is tied to an inputs hash so
// stale deployment info invalidates instead of masquerading as conformance.
import { createHash } from "node:crypto";
import type { AssessmentKey } from "./types.ts";

export const HEALTH_POLICY_ID = "corp.api.independent-health";
export const HEALTH_POLICY_VERSION = "1.0.0";

export interface HealthDeploymentInput {
	service: string;
	/** was the deployment manifest retrievable at all? */
	manifestKnown: boolean;
	/** processes/containers in the deployment: api | health-reporter */
	roles: string[];
	/** reporter runs as its own process/container, supervised independently */
	reporterSupervision: "independent" | "shared" | "none";
	/** what central monitoring evaluates: the reporter's verdict or API liveness */
	monitoringWiring: "reporter-verdict" | "api-liveness" | "none";
	/** evidence-revision token over the assessed source tree ("<sha>:<dirty|clean>"
	 *  or "unknown") — a changed tree invalidates the recorded evidence. */
	sourceRevision?: string;
}

export interface HealthAssessment {
	verdict: "conforming" | "gap" | "partial" | "unknown";
	/** assessment state machine mapping (partial folds into gap) */
	state: "conforming" | "gap" | "unknown";
	evidence: string[];
}

/** Assess a deployment against the health policy. Missing deployment
 *  information produces unknown, never conformance. */
export function assessHealthPolicy(
	input: HealthDeploymentInput,
): HealthAssessment {
	if (!input.manifestKnown || input.roles.length === 0)
		return {
			verdict: "unknown",
			state: "unknown",
			evidence: [
				"deployment manifest or process inventory missing — bounded evidence request required",
			],
		};
	const hasReporter = input.roles.includes("health-reporter");
	const hasApi = input.roles.includes("api");
	if (!hasApi)
		return {
			verdict: "unknown",
			state: "unknown",
			evidence: ["no api process in inventory — not a deployable API service"],
		};
	if (!hasReporter)
		return {
			verdict: "gap",
			state: "gap",
			evidence: [
				"no independent health reporter in the deployment manifest — an in-process /health route is insufficient evidence of independent reporting",
			],
		};
	const ev: string[] = [
		"independent health reporter present in the deployment",
	];
	if (input.reporterSupervision !== "independent")
		return {
			verdict: "partial",
			state: "gap",
			evidence: [
				...ev,
				`reporter supervision is "${input.reporterSupervision}" — reporter survival is coupled to the API lifecycle`,
			],
		};
	if (input.monitoringWiring !== "reporter-verdict")
		return {
			verdict: "partial",
			state: "gap",
			evidence: [
				...ev,
				`central monitoring evaluates "${input.monitoringWiring}" — an unreachable reporter must surface as unknown/unavailable, and a failed API must be reported truthfully, so monitoring must wire to the reporter verdict`,
			],
		};
	return {
		verdict: "conforming",
		state: "conforming",
		evidence: [
			...ev,
			'central monitoring wired to the reporter verdict ("reporter-verdict")',
		],
	};
}

/** Hash over the policy-relevant inputs. Session entry compares this against
 *  the stored assessment: match reuses evidence, change invalidates it. */
export function healthInputsHash(input: HealthDeploymentInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				manifestKnown: input.manifestKnown,
				roles: [...input.roles].sort(),
				reporterSupervision: input.reporterSupervision,
				monitoringWiring: input.monitoringWiring,
				sourceRevision: input.sourceRevision ?? "unknown",
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

/** The assessment key for a service under this policy. orgId is the
 *  organization-assigned stable identity — never a checkout path. */
export function healthAssessmentKey(
	project: string,
	orgId: string,
	serviceId: string,
): AssessmentKey {
	return {
		project,
		orgId,
		serviceId,
		policyId: HEALTH_POLICY_ID,
	};
}
