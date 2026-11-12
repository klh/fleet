import { z } from "zod";
import { ArmReceiptSchema } from "../paired/contracts.ts";
import {
	CaseSchema,
	CountSchema,
	ImageReferenceSchema,
	Sha256Schema,
} from "./cases.ts";
import { StrategySchema, strategyDigest } from "./strategies.ts";

export const AttemptSchema = z.strictObject({
	version: z.literal(1),
	caseId: z.string().min(1),
	repositoryFingerprint: Sha256Schema,
	oracleSha256: Sha256Schema,
	strategySha256: Sha256Schema,
	status: z.enum([
		"completed",
		"transport_failure",
		"harness_failure",
		"censored",
		"cancelled",
		"unsupported",
	]),
	image: ImageReferenceSchema,
	runtimeSha256: Sha256Schema,
	toolsetSha256: Sha256Schema,
	patchSha256: Sha256Schema.nullable(),
	settings: z.strictObject({
		requestedEffort: z.string().min(1),
		effectiveEffort: z.string().min(1).nullable(),
		verified: z.boolean(),
		receiptSha256: Sha256Schema.nullable(),
	}),
	checks: z
		.strictObject({
			targetsPassed: CountSchema,
			regressionsPassed: CountSchema,
		})
		.nullable(),
	route: z.strictObject({
		requested: z.string().min(1),
		served: z.string().min(1).nullable(),
		verified: z.boolean(),
		receiptSha256: Sha256Schema.nullable(),
	}),
	cleanup: z.strictObject({
		keysRevoked: z.boolean(),
		resourcesRemoved: z.boolean(),
		receiptSha256: Sha256Schema.nullable(),
	}),
	receipt: ArmReceiptSchema,
});
export type Attempt = z.infer<typeof AttemptSchema>;

export type Assessment = {
	kind:
		| "accepted"
		| "quality_failure"
		| "effort_unverified"
		| "invalid_evidence"
		| Exclude<z.infer<typeof AttemptSchema.shape.status>, "completed">;
	reason: string;
};

/** Assess trusted host receipts; candidate claims alone are never evidence. */
export function assessAttempt(
	caseInput: unknown,
	strategyInput: unknown,
	input: unknown,
): Assessment {
	const scenario = CaseSchema.parse(caseInput),
		strategy = StrategySchema.parse(strategyInput);
	const parsed = AttemptSchema.safeParse(input);
	if (!parsed.success)
		return { kind: "invalid_evidence", reason: "Malformed attempt receipt" };
	const attempt = parsed.data;
	if (attempt.status !== "completed")
		return { kind: attempt.status, reason: "Attempt did not complete" };
	const { receipt, route, cleanup, checks } = attempt;
	if (receipt.timedOut)
		return { kind: "censored", reason: "Executor deadline reached" };
	if (receipt.executorExit !== 0)
		return { kind: "harness_failure", reason: "Executor failed" };
	if (
		attempt.caseId !== scenario.id ||
		attempt.repositoryFingerprint !== scenario.repositoryFingerprint ||
		attempt.oracleSha256 !== scenario.oracle.sha256 ||
		receipt.harnessSha256 !== strategy.harnessSha256 ||
		receipt.baseSha !== scenario.baseSha ||
		attempt.image !== scenario.image ||
		attempt.strategySha256 !== strategyDigest(strategy) ||
		attempt.runtimeSha256 !== strategy.runtimeSha256 ||
		attempt.toolsetSha256 !== strategy.toolsetSha256 ||
		receipt.model !== strategy.modelRoute ||
		route.requested !== strategy.modelRoute
	)
		return {
			kind: "invalid_evidence",
			reason: "Case or execution identity drifted",
		};
	if (
		!attempt.settings.verified ||
		!attempt.settings.effectiveEffort ||
		!attempt.settings.receiptSha256 ||
		attempt.settings.requestedEffort !== strategy.requestedEffort ||
		attempt.settings.effectiveEffort !== strategy.requestedEffort
	)
		return {
			kind: "effort_unverified",
			reason: "Requested effort was not verified on the served route",
		};
	if (
		!receipt.tokens ||
		!route.verified ||
		!route.served ||
		!route.receiptSha256 ||
		!cleanup.keysRevoked ||
		!cleanup.resourcesRemoved ||
		!cleanup.receiptSha256 ||
		!attempt.patchSha256 ||
		receipt.judgeExit === null ||
		!checks
	)
		return {
			kind: "invalid_evidence",
			reason: "Usage, route, patch, judge or cleanup evidence missing",
		};
	if (
		checks.targetsPassed > scenario.oracle.targets ||
		checks.regressionsPassed > scenario.oracle.regressions
	)
		return {
			kind: "invalid_evidence",
			reason: "Judge counts exceed controlled case",
		};
	const accepted =
		receipt.judgeExit === 0 &&
		receipt.quality === 1 &&
		checks.targetsPassed === scenario.oracle.targets &&
		checks.regressionsPassed === scenario.oracle.regressions;
	return {
		kind: accepted ? "accepted" : "quality_failure",
		reason: accepted
			? "All controlled checks passed"
			: "Target or regression checks failed",
	};
}
