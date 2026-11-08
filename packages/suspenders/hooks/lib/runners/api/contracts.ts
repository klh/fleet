import { z } from "zod";
import { RunnerSpecSchema } from "../control/control-state.ts";

export const RunnerProfileSchema = RunnerSpecSchema.omit({
	runId: true,
	owner: true,
});
export type RunnerProfile = z.infer<typeof RunnerProfileSchema>;
export const RunnerAdmissionSchema = z.strictObject({
	runId: z.uuid(),
	profile: z.string().min(1).max(120),
	autoPark: z.boolean().optional(),
});
export const RunnerSubmitSchema = z.strictObject({
	requestId: z.string().min(1).max(128),
	text: z.string().min(1).max(60_000),
});
export const RunnerReaderSchema = z.strictObject({ readerId: z.uuid() });
export const EmptySchema = z.strictObject({});
export const RunIdSchema = z.uuid();
export const SinceSchema = z.coerce
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER);
