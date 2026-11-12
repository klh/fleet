import { createHash } from "node:crypto";
import { z } from "zod";
import { Sha256Schema } from "./cases.ts";

/** Declared experimental settings; effective provider settings need receipts. */
export const StrategySchema = z.strictObject({
	version: z.literal(1),
	id: z.string().min(1),
	modelRoute: z.string().min(1),
	harnessSha256: Sha256Schema,
	runtimeSha256: Sha256Schema,
	toolsetSha256: Sha256Schema,
	context: z
		.array(
			z.enum([
				"minimal",
				"source-map",
				"quoted-lines",
				"ast",
				"parent-fork",
				"evidence-packet",
			]),
		)
		.min(1),
	inspection: z.enum(["serial", "batch"]),
	verificationTool: z.boolean(),
	orchestration: z.enum([
		"solo",
		"parallel-tools",
		"parent-selected",
		"independent-workers",
	]),
	requestedEffort: z.string().min(1),
	workerEffort: z.string().min(1).nullable(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export function strategyDigest(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(StrategySchema.parse(input)))
		.digest("hex");
}
