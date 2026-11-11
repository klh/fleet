import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const ImageReferenceSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const CountSchema = z.number().int().nonnegative();
const CheckResultSchema = z.strictObject({
	targetsPassed: CountSchema,
	regressionsPassed: CountSchema,
});
const ControlSchema = z.strictObject({
	id: z.string().min(1),
	base: CheckResultSchema,
	fixed: CheckResultSchema,
	receiptSha256: Sha256Schema,
});

/** Host-only case record. Never serialize this entire record into a prompt. */
export const CaseSchema = z
	.strictObject({
		version: z.literal(1),
		id: z.string().min(1),
		repository: z.string().min(1),
		language: z.string().min(1),
		problemClass: z.string().min(1),
		repositoryFingerprint: Sha256Schema,
		baseSha: CommitShaSchema,
		fixedSha: CommitShaSchema,
		image: ImageReferenceSchema,
		brief: z.string().min(1),
		oracle: z.strictObject({
			sha256: Sha256Schema,
			argv: z.array(z.string().min(1)).min(1),
			targets: CountSchema.positive(),
			regressions: CountSchema.positive(),
		}),
		controls: z.array(ControlSchema).min(2).max(100),
	})
	.refine(
		(value) => {
			const { controls, oracle } = value;
			return (
				value.baseSha !== value.fixedSha &&
				new Set(controls.map((control) => control.id)).size ===
					controls.length &&
				controls.every(
					({ base, fixed }) =>
						base.targetsPassed < oracle.targets &&
						base.targetsPassed === controls[0].base.targetsPassed &&
						fixed.targetsPassed === oracle.targets &&
						base.regressionsPassed === oracle.regressions &&
						fixed.regressionsPassed === oracle.regressions,
				)
			);
		},
		{
			message:
				"Distinct repeat controls must reproduce a stable failing base and passing fix without regressions",
			path: ["controls"],
		},
	);

export type ReplayCase = z.infer<typeof CaseSchema>;

/** The only case view passed to an executor's task context. */
export function publicTask(input: unknown) {
	const value = CaseSchema.parse(input);
	return {
		caseId: value.id,
		task: value.brief,
		baseSha: value.baseSha,
		language: value.language,
		problemClass: value.problemClass,
	};
}
