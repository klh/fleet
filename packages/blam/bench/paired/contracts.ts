import { isAbsolute } from "node:path";
import { z } from "zod";

const AbsolutePathSchema = z
	.string()
	.refine(isAbsolute, "Absolute path required");
const ArgvSchema = z.array(z.string().min(1)).min(1);
const CountSchema = z.number().int().nonnegative();

/** Shared executor manifest; filesystem isolation is checked by the runner. */
export const LiveManifestSchema = z.strictObject({
	repo: AbsolutePathSchema,
	baseRef: z.string().min(1),
	task: z.string().min(1),
	model: z.string().min(1),
	baseline: z.string(),
	candidate: z.string(),
	reps: z.number().int().positive(),
	executor: ArgvSchema,
	judge: ArgvSchema,
	timeoutMs: z.number().int().positive(),
	outputDir: AbsolutePathSchema,
});
export type LiveManifest = z.infer<typeof LiveManifestSchema>;

/** Null means unreported; a known zero remains zero for eligibility checks. */
export const ArmReceiptSchema = z.strictObject({
	arm: z.enum(["baseline", "candidate"]),
	rep: CountSchema,
	laneId: z.string().min(1),
	baseSha: z.string().regex(/^[a-f0-9]{40}$/),
	harnessSha256: z.string().regex(/^[a-f0-9]{64}$/),
	model: z.string().min(1),
	executorExit: z.number().int(),
	judgeExit: z.number().int().nullable(),
	timedOut: z.boolean(),
	tokens: CountSchema.nullable(),
	cacheReadTokens: CountSchema.nullable(),
	cacheWriteTokens: CountSchema.nullable(),
	quality: z.number().min(0).max(1),
	wallMs: z.number().nonnegative(),
	judgeMs: z.number().nonnegative().nullable(),
	outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
	patchFile: z.string().min(1),
});
export type ArmReceipt = z.infer<typeof ArmReceiptSchema>;
