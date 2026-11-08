// Measured runner receipts: environment reuse and model reuse are separate tracks.
import { z } from "zod";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const metric = z.number().finite().nonnegative();
export const RunnerSetupSchema = z.strictObject({
	taskDigest: text,
	repoRevision: text,
	host: text,
	runtime: text,
	model: text,
	provider: text,
	cacheCondition: text,
	policyDigest: text,
	dependenciesDigest: text,
	judgeDigest: text,
});
export const RunnerUsageSchema = z
	.strictObject({
		// input includes cached input; never add cachedInput to input again.
		input: count,
		cachedInput: count.nullable(),
		output: count,
	})
	.refine(
		(u) => u.cachedInput === null || u.cachedInput <= u.input,
		"cached input exceeds input",
	);
export const RunnerReceiptSchema = z
	.strictObject({
		version: z.literal(1),
		experiment: text,
		track: z.enum(["infrastructure", "inference", "agentic"]),
		arm: z.enum(["baseline", "candidate"]),
		rep: count,
		order: z.union([z.literal(0), z.literal(1)]),
		setup: RunnerSetupSchema,
		seedDigest: text,
		jobId: text,
		readyMs: metric.nullable(),
		firstByteMs: metric.nullable().optional(),
		firstUsefulMs: metric.nullable(),
		wallMs: metric,
		rssBytes: metric.nullable(),
		diskBytes: metric.nullable(),
		usage: RunnerUsageSchema.nullable(),
		quality: z.number().min(0).max(1),
		exitCode: z.number().int(),
		timedOut: z.boolean(),
		isolationFailures: count.nullable(),
		artifactDigest: text,
		evidence: text,
	})
	.refine(
		(r) => r.readyMs === null || r.readyMs <= r.wallMs,
		"ready exceeds wall",
	)
	.refine(
		(r) => r.firstByteMs == null || r.firstByteMs <= r.wallMs,
		"first byte exceeds wall",
	)
	.refine(
		(r) => r.firstUsefulMs === null || r.firstUsefulMs <= r.wallMs,
		"useful exceeds wall",
	)
	.refine(
		(r) =>
			r.readyMs === null ||
			r.firstUsefulMs === null ||
			r.readyMs <= r.firstUsefulMs,
		"useful precedes ready",
	);
export type RunnerReceipt = z.infer<typeof RunnerReceiptSchema>;
export type RunnerSetup = z.infer<typeof RunnerSetupSchema>;

export function readReceipts(ndjson: string): RunnerReceipt[] {
	return ndjson
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			const parsed = RunnerReceiptSchema.safeParse(JSON.parse(line));
			if (!parsed.success)
				throw new Error(`receipt line ${i + 1}: ${parsed.error.message}`);
			return parsed.data;
		});
}
