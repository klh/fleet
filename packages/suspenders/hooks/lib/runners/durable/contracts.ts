import { z } from "zod";
export const JobSpecSchema = z.strictObject({
	version: z.literal(1),
	runId: z.uuid(),
	owner: z.string().min(1).max(200),
	generation: z.number().int().positive(),
	kind: z.enum(["coding", "design", "knowledge"]),
	seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
	policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
	provider: z.string().min(1).max(120),
	model: z.string().min(1).max(200),
});
export const JobManifestSchema = z.strictObject({
	spec: JobSpecSchema,
	runtime: z.literal("pi-durable@1.5.0"),
	host: z.string().min(1),
});
export const JobInputSchema = z.strictObject({
	requestId: z.string().min(1).max(128),
	text: z.string().min(1).max(100000),
	whenBusy: z.enum(["steer", "followUp", "reject"]).optional(),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;
export type JobAction =
	| "open"
	| "read"
	| "submit"
	| "resume"
	| "abort"
	| "execute";
/** Host-owned admission and rights policy; never supplied by an agent payload. */
export type Authorize = (action: JobAction, spec: JobSpec) => Promise<void>;
