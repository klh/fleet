import { z } from "zod";

export const RunnerSubmissionSchema = z.strictObject({
	text: z.string().min(1).max(100_000),
	requestId: z.string().min(1).max(128).optional(),
});
const HeldSchema = z.array(
	z.union([z.string().min(1), RunnerSubmissionSchema]),
);

/** Older journals stored strings. Keep their display and delivery compatible. */
export function heldSubmissions(raw: string) {
	return HeldSchema.parse(JSON.parse(raw)).map((value) =>
		typeof value === "string" ? { text: value } : value,
	);
}
