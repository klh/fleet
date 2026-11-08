import { z } from "zod";
export const MAX_EVIDENCE_OUTPUT = 1048576;
const ResultSchema = z
	.object({
		output: z.string().max(MAX_EVIDENCE_OUTPUT),
		session_id: z.number().int().positive().optional(),
		exit_code: z.number().int().nullable().optional(),
	})
	.strip();
export type EvidenceResult = z.infer<typeof ResultSchema>;
export type DecodedOutput =
	| { kind: "structured"; result: EvidenceResult }
	| { kind: "legacy"; text: string };

/** Read only the tool's result payload; assistant-authored extra text is not evidence. */
export function evidenceOutput(content: string): DecodedOutput | null {
	if (
		!content.includes("Script completed") ||
		content.length > MAX_EVIDENCE_OUTPUT
	)
		return null;
	const marker = content.indexOf("\nOutput:\n");
	if (marker < 0) return null;
	const text = content.slice(marker + "\nOutput:\n".length).trim();
	if (!text.startsWith("{")) return { kind: "legacy", text };
	try {
		const parsed = ResultSchema.safeParse(JSON.parse(text));
		return parsed.success ? { kind: "structured", result: parsed.data } : null;
	} catch {
		return null;
	}
}
