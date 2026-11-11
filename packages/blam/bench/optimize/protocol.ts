import { z } from "zod";
import { ImageReferenceSchema, Sha256Schema } from "./cases.ts";
import { StrategySchema } from "./strategies.ts";

/** Evidence-backed proposal; activation belongs to the deployment policy. */
export const RecommendationSchema = z
	.strictObject({
		version: z.literal(1),
		state: z.literal("recommendation"),
		repository: z.string().min(1),
		repositoryFingerprint: Sha256Schema,
		language: z.string().min(1),
		problemClass: z.string().min(1),
		image: ImageReferenceSchema,
		strategy: StrategySchema,
		caseIds: z.array(z.string().min(1)).min(2),
		confirmations: z.number().int().min(3),
		historySha256: Sha256Schema,
		createdAt: z.iso.datetime(),
	})
	.refine((value) => new Set(value.caseIds).size === value.caseIds.length, {
		message: "Held-out case IDs must be distinct",
		path: ["caseIds"],
	});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** NDJSON lifecycle records carry evidence references, never raw secrets. */
export const CampaignEventSchema = z
	.strictObject({
		version: z.literal(1),
		runId: z.string().min(1),
		at: z.iso.datetime(),
		kind: z.enum([
			"planned",
			"admitted",
			"started",
			"first_useful_result",
			"first_edit",
			"child_started",
			"joined",
			"terminal",
			"judged",
			"cleanup",
		]),
		evidenceSha256: Sha256Schema.nullable(),
		evidenceKind: z
			.enum(["source-range", "behavioral-test", "receipt"])
			.nullable(),
		elapsedMs: z.number().nonnegative(),
		childRunIds: z.array(z.string().min(1)),
	})
	.refine(
		(value) =>
			value.kind !== "first_useful_result" ||
			(value.evidenceSha256 !== null &&
				value.evidenceKind !== null &&
				value.evidenceKind !== "receipt"),
		{
			message: "Useful work requires source or behavioral-test evidence",
			path: ["evidenceKind"],
		},
	);
export type CampaignEvent = z.infer<typeof CampaignEventSchema>;
